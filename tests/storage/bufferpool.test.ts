import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { USABLE_PAGE_SIZE } from "../../src/constants.js";
import { BufferPoolError } from "../../src/errors.js";
import { BufferPool } from "../../src/storage/bufferpool.js";
import { Pager } from "../../src/storage/pager.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

describe("BufferPool", () => {
  let tmp: TempDb;
  let pager: Pager;

  beforeEach(() => {
    tmp = makeTempDb();
    pager = Pager.open(tmp.path);
  });

  afterEach(() => {
    pager.close();
    tmp.cleanup();
  });

  /** Allocate `n` pages, stamping each with its page number for later checks. */
  function stampPages(pool: BufferPool, n: number): number[] {
    const nums: number[] = [];
    for (let i = 0; i < n; i++) {
      const pageNo = pool.allocatePage();
      const page = pool.fetchPage(pageNo);
      page.writeUInt32LE(pageNo, 0);
      // Stamp only the content area; the pager owns the checksum trailer.
      page.fill(pageNo & 0xff, 4, USABLE_PAGE_SIZE);
      pool.unpin(pageNo, true);
      nums.push(pageNo);
    }
    return nums;
  }

  it("survives eviction: a page read back after being evicted still matches", () => {
    const pool = new BufferPool(pager, 4);

    const nums = stampPages(pool, 32); // far exceeds capacity -> forces eviction
    pool.flushAll();

    for (const pageNo of nums) {
      const page = pool.fetchPage(pageNo);
      expect(page.readUInt32LE(0)).toBe(pageNo);
      expect(page[4]).toBe(pageNo & 0xff);
      expect(page[USABLE_PAGE_SIZE - 1]).toBe(pageNo & 0xff);
      pool.unpin(pageNo, false);
    }
  });

  it("never evicts a pinned page", () => {
    const pool = new BufferPool(pager, 4);
    const nums = stampPages(pool, 4);

    // Pin every frame and keep the pins held.
    for (const pageNo of nums) pool.fetchPage(pageNo);

    // A miss now has nowhere to go: every frame is pinned.
    const extra = pool.allocatePage();
    expect(() => pool.fetchPage(extra)).toThrow(BufferPoolError);

    // The pinned pages are still intact and resident.
    for (const pageNo of nums) {
      expect(pool.fetchPage(pageNo).readUInt32LE(0)).toBe(pageNo);
      pool.unpin(pageNo, false);
      pool.unpin(pageNo, false); // release the extra pin from the loop above
    }
  });

  it("tracks hit rate across hits and misses", () => {
    const pool = new BufferPool(pager, 8);
    const nums = stampPages(pool, 4); // 4 misses during stamping
    pool.resetStats();

    // Touch the 4 resident pages -> 4 hits.
    for (const pageNo of nums) {
      pool.fetchPage(pageNo);
      pool.unpin(pageNo, false);
    }
    expect(pool.hitCount).toBe(4);
    expect(pool.missCount).toBe(0);
    expect(pool.hitRate()).toBe(1);

    // Evict everything, then re-touch -> misses again.
    pool.invalidateAll();
    pool.resetStats();
    for (const pageNo of nums) {
      pool.fetchPage(pageNo);
      pool.unpin(pageNo, false);
    }
    expect(pool.missCount).toBe(4);
    expect(pool.hitRate()).toBe(0);
  });

  it("gives a re-touched page a second chance over an untouched one (clock policy)", () => {
    const pool = new BufferPool(pager, 3);
    const [, p2, p3] = stampPages(pool, 3) as [number, number, number];

    // First miss sweeps all three reference bits (set when stamped), evicting
    // the oldest, p1. Afterwards p2 and p3 have their ref bits cleared.
    const p4 = pool.allocatePage();
    pool.fetchPage(p4);
    pool.unpin(p4, false);

    // Re-touch p2: its reference bit goes back to 1. p3 stays at 0.
    pool.fetchPage(p2);
    pool.unpin(p2, false);

    // Next miss must evict p3 (ref 0) and spare p2 (second chance).
    const p5 = pool.allocatePage();
    pool.fetchPage(p5);
    pool.unpin(p5, false);

    pool.resetStats();
    pool.fetchPage(p2);
    pool.unpin(p2, false);
    expect(pool.hitCount).toBe(1); // p2 survived

    pool.fetchPage(p3);
    pool.unpin(p3, false);
    expect(pool.missCount).toBe(1); // p3 was evicted
  });

  it("flushes dirty pages so they persist through the pager", () => {
    const pool = new BufferPool(pager, 16);
    const nums = stampPages(pool, 10);
    pool.flushAll();
    pool.invalidateAll();

    // Read straight from the pager (bypassing the pool) to prove durability.
    for (const pageNo of nums) {
      expect(pager.readPage(pageNo).readUInt32LE(0)).toBe(pageNo);
    }
    expect(pool.pinnedCount()).toBe(0);
  });
});
