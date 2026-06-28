import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BufferPool } from "../../src/storage/bufferpool.js";
import { Heap } from "../../src/storage/heap.js";
import { Pager } from "../../src/storage/pager.js";
import { DirectTx } from "../../src/storage/tx.js";
import { makeStorage, type StorageStack } from "../helpers/storage.js";

describe("Heap", () => {
  let s: StorageStack;
  let heap: Heap;

  beforeEach(() => {
    s = makeStorage(32);
    heap = new Heap();
  });

  afterEach(() => {
    s.cleanup();
  });

  it("spans multiple pages and scans every live record back in order", () => {
    const root = heap.create(s.tx);
    const payloads = Array.from({ length: 2_000 }, (_, i) => Buffer.from(`row-${i}-${"#".repeat(i % 40)}`));

    const rids = payloads.map((p) => heap.insert(s.tx, root, p));
    // Many records of varying size must have spilled onto fresh pages.
    expect(new Set(rids.map((r) => r.pageNo)).size).toBeGreaterThan(1);

    const scanned = [...heap.scan(s.tx, root)].map((r) => r.bytes.toString());
    expect(scanned).toEqual(payloads.map((p) => p.toString()));

    // Point reads by rid match.
    rids.forEach((rid, i) => {
      expect(heap.get(s.tx, rid).equals(payloads[i]!)).toBe(true);
    });
  });

  it("tombstones deleted records and excludes them from scans", () => {
    const root = heap.create(s.tx);
    const rids = ["a", "bb", "ccc", "dddd"].map((v) => heap.insert(s.tx, root, Buffer.from(v)));

    heap.delete(s.tx, rids[1]!);
    heap.delete(s.tx, rids[3]!);

    const live = [...heap.scan(s.tx, root)].map((r) => r.bytes.toString());
    expect(live).toEqual(["a", "ccc"]);
  });

  it("persists across flush + reopen", () => {
    const root = heap.create(s.tx);
    const rids = Array.from({ length: 500 }, (_, i) =>
      heap.insert(s.tx, root, Buffer.from(`persist-${i}`)),
    );
    const path = s.tmp.path;
    s.pager.setCatalogRoot(root);
    s.flushClose();

    const pager = Pager.open(path);
    const pool = new BufferPool(pager, 32);
    const tx = new DirectTx(pool);
    const reopened = new Heap();
    const reopenedRoot = pager.getCatalogRoot();

    expect([...reopened.scan(tx, reopenedRoot)].length).toBe(500);
    expect(reopened.get(tx, rids[0]!).toString()).toBe("persist-0");
    expect(reopened.get(tx, rids[499]!).toString()).toBe("persist-499");

    // Insert after reopen still appends at the true tail (cache rebuilt lazily).
    reopened.insert(tx, reopenedRoot, Buffer.from("after-reopen"));
    expect([...reopened.scan(tx, reopenedRoot)].length).toBe(501);

    pager.close();
  });
});
