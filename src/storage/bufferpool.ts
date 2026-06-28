import { PAGE_SIZE } from "../constants.js";
import { BufferPoolError } from "../errors.js";
import type { Pager } from "./pager.js";

interface Frame {
  /** Page resident in this frame, or -1 when the frame is empty. */
  pageNo: number;
  /** Reused PAGE_SIZE buffer holding the page image. */
  readonly page: Buffer;
  /** Number of outstanding pins; a frame is evictable only at 0. */
  pinCount: number;
  /** Set when the resident page was modified and not yet written back. */
  dirty: boolean;
  /** Clock reference bit: set on access, cleared by the sweeping hand. */
  ref: boolean;
  /** LSN of the last WAL record that modified this page (write-ahead ordering). */
  pageLSN: bigint;
}

/**
 * Called before a dirty page is written to the data file. The WAL durability
 * guard forces the log up to the page's LSN, enforcing the write-ahead rule.
 * Absent (Phase 1–5 contexts) it is a no-op.
 */
export type BeforeFlush = (pageLSN: bigint) => void;

/**
 * A fixed set of frames caching pages in memory, with clock (second-chance)
 * eviction. Holds pins so an in-use page is never evicted, tracks dirty pages
 * for write-back, and exposes a hit-rate counter.
 */
export class BufferPool {
  private readonly frames: Frame[];
  private readonly table = new Map<number, number>(); // pageNo -> frame index
  private hand = 0;
  private hits = 0;
  private misses = 0;
  private beforeFlush: BeforeFlush | undefined;

  constructor(
    private readonly pager: Pager,
    readonly capacity = 128,
  ) {
    if (capacity < 1) throw new BufferPoolError("buffer pool capacity must be >= 1");
    this.frames = Array.from({ length: capacity }, () => ({
      pageNo: -1,
      page: Buffer.alloc(PAGE_SIZE),
      pinCount: 0,
      dirty: false,
      ref: false,
      pageLSN: 0n,
    }));
  }

  /** Install the WAL durability guard. Called once when a WAL is attached. */
  setBeforeFlush(hook: BeforeFlush): void {
    this.beforeFlush = hook;
  }

  /**
   * Pin a page and return its in-memory buffer. Mutating the buffer mutates the
   * cached page directly; callers must `unpin` (with isDirty) when done.
   */
  fetchPage(pageNo: number): Buffer {
    const existing = this.table.get(pageNo);
    if (existing !== undefined) {
      const frame = this.frames[existing]!;
      frame.pinCount += 1;
      frame.ref = true;
      this.hits += 1;
      return frame.page;
    }

    this.misses += 1;
    const idx = this.evictFrame();
    const frame = this.frames[idx]!;
    this.pager.readPageInto(pageNo, frame.page);
    frame.pageNo = pageNo;
    frame.pinCount = 1;
    frame.dirty = false;
    frame.ref = true;
    frame.pageLSN = 0n;
    this.table.set(pageNo, idx);
    return frame.page;
  }

  /** Release a pin. Pass isDirty=true if the page was modified through its buffer. */
  unpin(pageNo: number, isDirty: boolean): void {
    const idx = this.table.get(pageNo);
    if (idx === undefined) {
      throw new BufferPoolError(`unpin of non-resident page ${pageNo}`);
    }
    const frame = this.frames[idx]!;
    if (frame.pinCount === 0) {
      throw new BufferPoolError(`unpin of unpinned page ${pageNo}`);
    }
    frame.pinCount -= 1;
    if (isDirty) frame.dirty = true;
  }

  /** Record the LSN that last modified a resident page (for write-ahead ordering). */
  setPageLSN(pageNo: number, lsn: bigint): void {
    const idx = this.table.get(pageNo);
    if (idx === undefined) {
      throw new BufferPoolError(`setPageLSN on non-resident page ${pageNo}`);
    }
    const frame = this.frames[idx]!;
    if (lsn > frame.pageLSN) frame.pageLSN = lsn;
  }

  /** Allocate a brand-new page in the file. Not pinned; fetch it to use it. */
  allocatePage(): number {
    return this.pager.allocatePage();
  }

  /** Find a frame to use: a free one, else evict via the clock algorithm. */
  private evictFrame(): number {
    // Fast path: an empty frame needs no eviction.
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i]!.pageNo === -1) return i;
    }

    // Clock sweep. Two full passes is enough: pass one clears reference bits,
    // pass two evicts. If nothing is evictable, every frame is pinned.
    const limit = this.frames.length * 2;
    for (let steps = 0; steps <= limit; steps++) {
      const idx = this.hand;
      this.hand = (this.hand + 1) % this.frames.length;
      const frame = this.frames[idx]!;
      if (frame.pinCount > 0) continue;
      if (frame.ref) {
        frame.ref = false;
        continue;
      }
      if (frame.dirty) this.flushFrame(frame);
      this.table.delete(frame.pageNo);
      frame.pageNo = -1;
      return idx;
    }

    throw new BufferPoolError(
      `buffer pool exhausted: all ${this.frames.length} frames are pinned`,
    );
  }

  private flushFrame(frame: Frame): void {
    if (!frame.dirty || frame.pageNo === -1) return;
    this.beforeFlush?.(frame.pageLSN); // write-ahead: log must be durable first
    this.pager.writePage(frame.pageNo, frame.page, false);
    frame.dirty = false;
  }

  /** Write one dirty page back through the pager (no fsync; caller batches sync). */
  flushPage(pageNo: number): void {
    const idx = this.table.get(pageNo);
    if (idx === undefined) return;
    this.flushFrame(this.frames[idx]!);
  }

  /** Write every dirty page back and fsync the data file. */
  flushAll(): void {
    let any = false;
    for (const frame of this.frames) {
      if (frame.dirty && frame.pageNo !== -1) {
        this.flushFrame(frame);
        any = true;
      }
    }
    if (any) this.pager.sync();
  }

  /**
   * Drop every cached page WITHOUT writing dirty pages back. This simulates a
   * crash: the data file keeps only what was already flushed, and recovery must
   * rebuild the rest from the WAL. Used by crash-recovery tests and on reopen.
   */
  invalidateAll(): void {
    this.table.clear();
    this.hand = 0;
    for (const frame of this.frames) {
      frame.pageNo = -1;
      frame.pinCount = 0;
      frame.dirty = false;
      frame.ref = false;
      frame.pageLSN = 0n;
    }
  }

  get hitCount(): number {
    return this.hits;
  }

  get missCount(): number {
    return this.misses;
  }

  /** Fraction of fetches served from cache, in [0, 1]. Zero before any access. */
  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /** Count of currently pinned frames — useful for leak assertions in tests. */
  pinnedCount(): number {
    return this.frames.reduce((n, f) => n + (f.pinCount > 0 ? 1 : 0), 0);
  }
}
