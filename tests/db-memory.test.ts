import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { LockError } from "../src/errors.js";
import { MemoryVfs } from "../src/storage/memory-vfs.js";

describe("in-memory storage backend", () => {
  it("runs CRUD entirely in RAM with no files on disk", () => {
    const db = Database.open(":memory:");
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "ann");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(2, "bob");

    expect(db.prepare("SELECT name FROM t ORDER BY id").values()).toEqual([["ann"], ["bob"]]);
    expect(existsSync(":memory:")).toBe(false); // nothing was written to the filesystem
    expect(existsSync(":memory:-wal")).toBe(false);
    db.close();
  });

  it("supports joins and aggregates in memory", () => {
    const db = Database.open(":memory:");
    db.exec("CREATE TABLE u (id INT PRIMARY KEY, name TEXT NOT NULL)");
    db.exec("CREATE TABLE o (id INT PRIMARY KEY, uid INT NOT NULL, amt INT NOT NULL)");
    db.prepare("INSERT INTO u (id, name) VALUES (?, ?)").run(1, "ann");
    db.prepare("INSERT INTO o (id, uid, amt) VALUES (?, ?, ?)").run(10, 1, 100);
    db.prepare("INSERT INTO o (id, uid, amt) VALUES (?, ?, ?)").run(11, 1, 50);

    const row = db
      .prepare("SELECT u.name AS name, SUM(o.amt) AS total FROM u JOIN o ON u.id = o.uid GROUP BY u.name")
      .get();
    expect(row).toEqual({ name: "ann", total: 150n });
    db.close();
  });

  it("handles overflow values and VACUUM in memory", () => {
    const db = Database.open(":memory:");
    db.exec("CREATE TABLE blobs (id INT PRIMARY KEY, data BLOB NOT NULL)");
    const big = Buffer.alloc(80_000, 9);
    for (let i = 1; i <= 5; i++) db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(i, big);
    db.exec("DELETE FROM blobs WHERE id > 1");

    const { pagesBefore, pagesAfter } = db.vacuum();
    expect(pagesAfter).toBeLessThan(pagesBefore);
    const back = db.prepare("SELECT data FROM blobs WHERE id = ?").pluck(1) as Buffer;
    expect(back.equals(big)).toBe(true);
    db.close();
  });

  it("keeps two :memory: databases independent", () => {
    const a = Database.open(":memory:");
    const b = Database.open(":memory:");
    a.exec("CREATE TABLE t (id INT PRIMARY KEY)");
    a.exec("INSERT INTO t (id) VALUES (1)");
    expect(b.tableNames()).toEqual([]); // b has its own empty store
    a.close();
    b.close();
  });

  it("persists within a shared MemoryVfs across reopen, and enforces single-writer", () => {
    const vfs = new MemoryVfs();
    const db = Database.open("app.db", { vfs });
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL)");
    db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, 42);

    // A second open on the same path + backend is refused while the first is live.
    expect(() => Database.open("app.db", { vfs })).toThrow(LockError);
    db.close();

    // After close the store remains in the Vfs, so reopening recovers the data.
    const again = Database.open("app.db", { vfs });
    expect(again.prepare("SELECT v FROM t WHERE id = ?").pluck(1)).toBe(42n);
    again.close();
  });

  it("dumps an in-memory database to SQL", () => {
    const db = Database.open(":memory:");
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "ann");
    const sql = db.dump();
    expect(sql).toContain("CREATE TABLE t");
    expect(sql).toContain("INSERT INTO t (id, name) VALUES (1, 'ann');");
    db.close();
  });
});
