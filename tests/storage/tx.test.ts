import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SlottedPageError } from "../../src/errors.js";
import { Heap } from "../../src/storage/heap.js";
import { MAX_RECORD_SIZE } from "../../src/storage/page.js";
import { makeStorage, type StorageStack } from "../helpers/storage.js";

describe("DirectTx.modify", () => {
  let s: StorageStack;

  beforeEach(() => {
    s = makeStorage(8);
  });

  afterEach(() => s.cleanup());

  it("releases the page pin even when the mutator throws", () => {
    const pageNo = s.tx.allocate();
    expect(() =>
      s.tx.modify(pageNo, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.pool.pinnedCount()).toBe(0);
  });

  it("does not leak frames when an oversized heap insert fails repeatedly", () => {
    const heap = new Heap();
    const root = heap.create(s.tx);
    const tooBig = Buffer.alloc(MAX_RECORD_SIZE + 1);

    // More failures than the pool has frames — a leak would exhaust the pool.
    for (let i = 0; i < 50; i++) {
      expect(() => heap.insert(s.tx, root, tooBig)).toThrow(SlottedPageError);
    }
    expect(s.pool.pinnedCount()).toBe(0);

    // The pool is still usable afterwards.
    heap.insert(s.tx, root, Buffer.from("ok"));
    expect([...heap.scan(s.tx, root)].map((r) => r.bytes.toString())).toEqual(["ok"]);
  });
});
