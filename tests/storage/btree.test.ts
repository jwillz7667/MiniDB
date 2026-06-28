import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BTree, LEAF_CAPACITY } from "../../src/storage/btree.js";
import { BufferPool } from "../../src/storage/bufferpool.js";
import { Pager } from "../../src/storage/pager.js";
import type { Rid } from "../../src/storage/rid.js";
import { DirectTx } from "../../src/storage/tx.js";
import { makeStorage, type StorageStack } from "../helpers/storage.js";

/** Deterministic distinct rid per insertion, so lookups can be verified. */
function ridFor(n: number): Rid {
  return { pageNo: n + 1, slot: n % 50 };
}

/** Small xorshift PRNG for reproducible "random" key sequences. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

describe("BTree", () => {
  let s: StorageStack;

  beforeEach(() => {
    s = makeStorage(256);
  });

  afterEach(() => {
    s.cleanup();
  });

  it("finds every key after sequential then random inserts, and scans them sorted", () => {
    let root = BTree.create(s.tx);
    const expected = new Map<bigint, Rid>();
    let counter = 0;

    const N = 100_000; // matches the spec's acceptance criterion; many split levels
    for (let i = 0; i < N; i++) {
      const key = BigInt(i);
      const rid = ridFor(counter++);
      BTree.insert(s.tx, root, key, rid);
      expected.set(key, rid);
    }

    const rng = makeRng(0xc0ffee);
    let inserted = 0;
    while (inserted < N) {
      const key = BigInt(N + Math.floor(rng() * 5_000_000));
      if (expected.has(key)) continue;
      const rid = ridFor(counter++);
      BTree.insert(s.tx, root, key, rid);
      expected.set(key, rid);
      inserted++;
    }

    for (const [key, rid] of expected) {
      const found = BTree.searchOne(s.tx, root, key);
      expect(found).toEqual(rid);
    }

    // Missing keys are not found.
    expect(BTree.searchOne(s.tx, root, -1n)).toBeNull();
    expect(BTree.searchOne(s.tx, root, 10_000_000_000n)).toBeNull();

    // In-order scan returns keys sorted and complete.
    const scanned = [...BTree.scanAll(s.tx, root)].map(([k]) => k);
    expect(scanned.length).toBe(expected.size);
    for (let i = 1; i < scanned.length; i++) {
      expect(scanned[i]! > scanned[i - 1]!).toBe(true);
    }
  });

  it("grows in height while keeping a stable root page once a leaf overflows", () => {
    const root = BTree.create(s.tx);
    expect(BTree.height(s.tx, root)).toBe(1); // a lone leaf

    // Fill exactly the leaf capacity: still a single leaf.
    for (let i = 0; i < LEAF_CAPACITY; i++) {
      BTree.insert(s.tx, root, BigInt(i), ridFor(i));
    }
    expect(BTree.height(s.tx, root)).toBe(1);

    // One more overflows the leaf. The root PAGE NUMBER stays the same (fixed
    // root), but the tree gains a level and the root becomes an internal node.
    BTree.insert(s.tx, root, BigInt(LEAF_CAPACITY), ridFor(LEAF_CAPACITY));
    expect(BTree.height(s.tx, root)).toBe(2);
    expect(BTree.searchOne(s.tx, root, BigInt(LEAF_CAPACITY))).toEqual(ridFor(LEAF_CAPACITY));
  });

  it("range scan returns exactly the keys in [lo, hi], in order", () => {
    let root = BTree.create(s.tx);
    for (let i = 0; i < 5_000; i++) {
      BTree.insert(s.tx, root, BigInt(i * 2), ridFor(i)); // even keys 0..9998
    }

    const expected: bigint[] = [];
    for (let k = 100; k <= 200; k += 2) expected.push(BigInt(k));

    const got = [...BTree.rangeScan(s.tx, root, 100n, 200n)].map(([k]) => k);
    expect(got).toEqual(expected); // inclusive boundaries, odd values absent
    expect(got[0]).toBe(100n);
    expect(got[got.length - 1]).toBe(200n);
  });

  it("supports duplicate keys via composite (key, rid) ordering", () => {
    let root = BTree.create(s.tx);
    const rids: Rid[] = [
      { pageNo: 7, slot: 3 },
      { pageNo: 2, slot: 9 },
      { pageNo: 5, slot: 1 },
    ];
    for (const rid of rids) BTree.insert(s.tx, root, 42n, rid);

    const found = BTree.search(s.tx, root, 42n);
    expect(found.length).toBe(3);
    // Returned in rid order (page then slot).
    expect(found).toEqual([
      { pageNo: 2, slot: 9 },
      { pageNo: 5, slot: 1 },
      { pageNo: 7, slot: 3 },
    ]);
  });

  it("tombstone delete hides an entry from search, scan, and range", () => {
    let root = BTree.create(s.tx);
    for (let i = 0; i < 1_000; i++) BTree.insert(s.tx, root, BigInt(i), ridFor(i));

    expect(BTree.delete(s.tx, root, 500n, ridFor(500))).toBe(true);
    expect(BTree.delete(s.tx, root, 500n, ridFor(500))).toBe(false); // already gone

    expect(BTree.searchOne(s.tx, root, 500n)).toBeNull();
    const range = [...BTree.rangeScan(s.tx, root, 498n, 502n)].map(([k]) => k);
    expect(range).toEqual([498n, 499n, 501n, 502n]);
    expect([...BTree.scanAll(s.tx, root)].length).toBe(999);
  });

  it("persists across flush + reopen", () => {
    let root = BTree.create(s.tx);
    for (let i = 0; i < 3_000; i++) BTree.insert(s.tx, root, BigInt(i * 3), ridFor(i));
    const path = s.tmp.path;
    s.pager.setCatalogRoot(root); // stash the root so we can find it after reopen
    s.flushClose();

    const pager = Pager.open(path);
    const pool = new BufferPool(pager, 64);
    const tx = new DirectTx(pool);
    const reopenedRoot = pager.getCatalogRoot();

    expect(BTree.searchOne(tx, reopenedRoot, 0n)).toEqual(ridFor(0));
    expect(BTree.searchOne(tx, reopenedRoot, 2_997n)).toEqual(ridFor(999));
    expect(BTree.searchOne(tx, reopenedRoot, 4n)).toBeNull(); // never inserted
    expect([...BTree.scanAll(tx, reopenedRoot)].length).toBe(3_000);

    pager.close();
  });
});
