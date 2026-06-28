import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogError } from "../../src/errors.js";
import { Catalog } from "../../src/record/catalog.js";
import type { Column } from "../../src/record/schema.js";
import { BufferPool } from "../../src/storage/bufferpool.js";
import { Heap } from "../../src/storage/heap.js";
import { Pager } from "../../src/storage/pager.js";
import { DirectTx } from "../../src/storage/tx.js";
import { makeStorage, type StorageStack } from "../helpers/storage.js";

const userColumns: Column[] = [
  { name: "id", type: "INT", nullable: false },
  { name: "email", type: "TEXT", nullable: false },
  { name: "verified", type: "BOOL", nullable: true },
];

describe("Catalog", () => {
  let s: StorageStack;

  beforeEach(() => {
    s = makeStorage(64);
  });

  afterEach(() => {
    s.cleanup();
  });

  it("bootstraps the system tables on a fresh database", () => {
    const heap = new Heap();
    const cat = Catalog.open(s.tx, s.pager, heap);

    expect(cat.getTable("minidb_tables")).toBeDefined();
    expect(cat.getTable("minidb_columns")).toBeDefined();
    expect(cat.getTable("minidb_indexes")).toBeDefined();
    expect(cat.listTables()).toHaveLength(0); // no user tables yet
  });

  it("creates a table and resolves it with the right columns after reopen", () => {
    const heap = new Heap();
    const cat = Catalog.open(s.tx, s.pager, heap);
    const meta = cat.createTable(s.tx, "users", userColumns);
    expect(meta.heapRoot).toBeGreaterThan(0);
    expect(meta.pkRoot).toBeGreaterThan(0);

    const path = s.tmp.path;
    s.flushClose();

    const pager = Pager.open(path);
    const pool = new BufferPool(pager, 64);
    const tx = new DirectTx(pool);
    const reopened = Catalog.open(tx, pager, new Heap());

    const users = reopened.requireTable("users");
    expect(users.columns).toEqual(userColumns);
    expect(users.heapRoot).toBe(meta.heapRoot);
    expect(users.pkRoot).toBe(meta.pkRoot);
    expect(reopened.listTables().map((t) => t.name)).toEqual(["users"]);

    pager.close();
  });

  it("rejects duplicate tables and reserved names", () => {
    const cat = Catalog.open(s.tx, s.pager, new Heap());
    cat.createTable(s.tx, "t", userColumns);

    expect(() => cat.createTable(s.tx, "T", userColumns)).toThrow(CatalogError); // case-insensitive
    expect(() => cat.createTable(s.tx, "minidb_secret", userColumns)).toThrow(CatalogError);
    expect(() => cat.requireTable("missing")).toThrow(CatalogError);
  });

  it("records secondary indexes and finds them after reopen", () => {
    const cat = Catalog.open(s.tx, s.pager, new Heap());
    cat.createTable(s.tx, "users", userColumns);
    cat.createIndex(s.tx, "users", "id", 7);

    expect(cat.findIndex("users", "id")?.root).toBe(7);
    expect(() => cat.createIndex(s.tx, "users", "id", 9)).toThrow(CatalogError); // duplicate
    expect(() => cat.createIndex(s.tx, "users", "nope", 9)).toThrow(CatalogError); // bad column

    const path = s.tmp.path;
    s.flushClose();

    const pager = Pager.open(path);
    const pool = new BufferPool(pager, 64);
    const reopened = Catalog.open(new DirectTx(pool), pager, new Heap());
    expect(reopened.getIndexes("users")).toEqual([
      { tableName: "users", columnName: "id", root: 7 },
    ]);
    pager.close();
  });
});
