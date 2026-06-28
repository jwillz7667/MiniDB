import {
  canInsert,
  deleteRecord,
  getNextPage,
  getRecord,
  initSlottedPage,
  insertRecord,
  isDeleted,
  recordLength,
  recordOffset,
  setNextPage,
  slotCount,
} from "./page.js";
import { SlottedPageError } from "../errors.js";
import type { Rid } from "./rid.js";
import type { Tx } from "./tx.js";

/** A live record yielded by a heap scan, with its physical address. */
export interface HeapRecord {
  readonly rid: Rid;
  readonly bytes: Buffer;
}

/**
 * A table heap: a singly-linked chain of slotted pages holding row bytes. New
 * rows are appended at the tail page; a small per-heap cache remembers the tail
 * so inserts are amortized O(1) instead of walking the chain every time.
 *
 * Tombstoned space mid-chain is never reused (no vacuum), matching the engine's
 * deferred-reclamation policy. One `Heap` instance is shared per database.
 */
export class Heap {
  /** rootPageNo -> last page in the chain (nextPage === 0). A hint, re-validated. */
  private readonly tailCache = new Map<number, number>();

  /** Create an empty heap (a single empty page) and return its root page number. */
  create(tx: Tx): number {
    const root = tx.allocate();
    tx.modify(root, (page) => initSlottedPage(page, 0));
    this.tailCache.set(root, root);
    return root;
  }

  /** Append `bytes` to the heap, returning the record's rid. */
  insert(tx: Tx, rootPageNo: number, bytes: Buffer): Rid {
    let pageNo = this.findTail(tx, rootPageNo);

    // The tail usually has room; if it is full, link a fresh tail page.
    const page = tx.read(pageNo);
    const fits = canInsert(page, bytes.length);
    tx.release(pageNo);

    if (!fits) {
      const newPage = tx.allocate();
      tx.modify(newPage, (p) => initSlottedPage(p, 0));
      tx.modify(pageNo, (p) => setNextPage(p, newPage));
      this.tailCache.set(rootPageNo, newPage);
      pageNo = newPage;
    }

    let slot = -1;
    tx.modify(pageNo, (p) => {
      slot = insertRecord(p, bytes);
    });
    return { pageNo, slot };
  }

  /** Read the record at `rid`. Throws if the slot is tombstoned or out of range. */
  get(tx: Tx, rid: Rid): Buffer {
    const page = tx.read(rid.pageNo);
    try {
      return getRecord(page, rid.slot);
    } finally {
      tx.release(rid.pageNo);
    }
  }

  /** Tombstone the record at `rid`. */
  delete(tx: Tx, rid: Rid): void {
    tx.modify(rid.pageNo, (page) => deleteRecord(page, rid.slot));
  }

  /**
   * Overwrite the record at `rid` in place. The new bytes MUST be exactly the
   * length of the existing record (the slotted layout cannot grow a record
   * without relocating it); callers that change the length delete + re-insert
   * instead. Used by same-length UPDATEs to keep the rid — and therefore every
   * index entry — stable.
   */
  overwrite(tx: Tx, rid: Rid, bytes: Buffer): void {
    tx.modify(rid.pageNo, (page) => {
      const len = recordLength(page, rid.slot);
      if (len !== bytes.length) {
        throw new SlottedPageError(
          `overwrite length ${bytes.length} != record length ${len} at ${rid.pageNo}:${rid.slot}`,
        );
      }
      bytes.copy(page, recordOffset(page, rid.slot));
    });
  }

  /** Yield every live record across the chain, in physical (page, slot) order. */
  *scan(tx: Tx, rootPageNo: number): Generator<HeapRecord> {
    let pageNo = rootPageNo;
    while (pageNo !== 0) {
      // Snapshot the page's records, then release before yielding so a paused
      // consumer never holds a pin (which could exhaust the buffer pool).
      const records: HeapRecord[] = [];
      let next = 0;
      const page = tx.read(pageNo);
      try {
        next = getNextPage(page);
        const count = slotCount(page);
        for (let slot = 0; slot < count; slot++) {
          if (!isDeleted(page, slot)) {
            records.push({ rid: { pageNo, slot }, bytes: getRecord(page, slot) });
          }
        }
      } finally {
        tx.release(pageNo);
      }
      yield* records;
      pageNo = next;
    }
  }

  /** Find (and cache) the chain's tail page — the one whose nextPage is 0. */
  private findTail(tx: Tx, rootPageNo: number): number {
    let pageNo = this.tailCache.get(rootPageNo) ?? rootPageNo;
    for (;;) {
      const page = tx.read(pageNo);
      const next = getNextPage(page);
      tx.release(pageNo);
      if (next === 0) break;
      pageNo = next;
    }
    this.tailCache.set(rootPageNo, pageNo);
    return pageNo;
  }

  /** Drop cached tails (e.g. after recovery rewrote the chain). */
  resetCache(): void {
    this.tailCache.clear();
  }
}
