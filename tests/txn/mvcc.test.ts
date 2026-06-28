import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TransactionError } from "../../src/errors.js";
import { makeSchema, type Schema, type Value } from "../../src/record/schema.js";
import type { Rid } from "../../src/storage/rid.js";
import { Heap } from "../../src/storage/heap.js";
import { MvccStore } from "../../src/txn/mvcc-store.js";
import { Transaction, TransactionManager } from "../../src/txn/transaction.js";
import { makeStorage, type StorageStack } from "../helpers/storage.js";

const schema: Schema = makeSchema([
  { name: "id", type: "INT", nullable: false },
  { name: "name", type: "TEXT", nullable: false },
]);

describe("MVCC snapshot isolation", () => {
  let s: StorageStack;
  let store: MvccStore;
  let mgr: TransactionManager;
  let root: number;

  beforeEach(() => {
    s = makeStorage(64);
    store = new MvccStore(new Heap(), schema);
    mgr = new TransactionManager();
    root = store.create(s.tx);
  });

  afterEach(() => s.cleanup());

  /** All rows visible to `txn`, sorted by id. */
  function rows(txn: Transaction): Value[][] {
    return [...store.scanVisible(s.tx, mgr, txn, root)]
      .map((r) => r.values)
      .sort((a, b) => Number((a[0] as bigint) - (b[0] as bigint)));
  }

  /** The rid of the version of row `id` currently visible to `txn`. */
  function ridOf(txn: Transaction, id: bigint): Rid {
    for (const r of store.scanVisible(s.tx, mgr, txn, root)) {
      if (r.values[0] === id) return r.rid;
    }
    throw new Error(`row ${id} not visible`);
  }

  /** Seed one committed row and return its id. */
  function seed(id: bigint, name: string): void {
    const t = mgr.begin();
    store.insert(s.tx, t, root, [id, name]);
    mgr.commit(t);
  }

  it("prevents non-repeatable reads (A keeps seeing the old value)", () => {
    seed(1n, "orig");

    const a = mgr.begin();
    expect(rows(a)).toEqual([[1n, "orig"]]);

    const b = mgr.begin();
    store.update(s.tx, mgr, b, root, ridOf(b, 1n), [1n, "changed"]);
    mgr.commit(b);

    // A's snapshot predates B's commit, so A still sees the original value.
    expect(rows(a)).toEqual([[1n, "orig"]]);

    // A transaction that starts after B sees the new value.
    const c = mgr.begin();
    expect(rows(c)).toEqual([[1n, "changed"]]);
  });

  it("makes a rolled-back transaction's writes invisible to everyone", () => {
    seed(1n, "a");

    const b = mgr.begin();
    store.insert(s.tx, b, root, [2n, "b"]);
    expect(rows(b)).toEqual([
      [1n, "a"],
      [2n, "b"],
    ]); // B sees its own write

    const concurrent = mgr.begin();
    expect(rows(concurrent)).toEqual([[1n, "a"]]); // not visible while B is in flight

    mgr.rollback(b);
    const after = mgr.begin();
    expect(rows(after)).toEqual([[1n, "a"]]); // and gone for good once aborted
  });

  it("lands concurrent inserts from two transactions without corrupting the heap", () => {
    const a = mgr.begin();
    const b = mgr.begin();
    store.insert(s.tx, a, root, [1n, "a"]);
    store.insert(s.tx, b, root, [2n, "b"]);

    // Neither sees the other's uncommitted row.
    expect(rows(a)).toEqual([[1n, "a"]]);
    expect(rows(b)).toEqual([[2n, "b"]]);

    mgr.commit(a);
    mgr.commit(b);

    const c = mgr.begin();
    expect(rows(c)).toEqual([
      [1n, "a"],
      [2n, "b"],
    ]);
    expect(store.versionCount(s.tx, root)).toBe(2); // both physically present, intact
  });

  it("a transaction sees its own uncommitted writes but others do not", () => {
    const a = mgr.begin();
    store.insert(s.tx, a, root, [1n, "mine"]);
    expect(rows(a)).toEqual([[1n, "mine"]]);

    const b = mgr.begin();
    expect(rows(b)).toEqual([]);
  });

  it("detects a write-write conflict (first updater wins)", () => {
    seed(1n, "x");

    const a = mgr.begin();
    const b = mgr.begin();

    store.update(s.tx, mgr, a, root, ridOf(a, 1n), [1n, "A"]);
    // B still sees the original version; updating it conflicts with A's pending delete.
    expect(() => store.update(s.tx, mgr, b, root, ridOf(b, 1n), [1n, "B"])).toThrow(
      TransactionError,
    );

    // Once A commits, the new version reflects A's write.
    mgr.commit(a);
    const c = mgr.begin();
    expect(rows(c)).toEqual([[1n, "A"]]);
  });
});
