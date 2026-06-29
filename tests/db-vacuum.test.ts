import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { ConstraintError, TransactionError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("VACUUM", () => {
  let tmp: TempDb;
  let db: Database;

  const reopen = (): Database => {
    rmSync(`${tmp.path}-lock`, { force: true });
    return Database.open(tmp.path);
  };

  beforeEach(() => {
    tmp = makeTempDb();
    db = Database.open(tmp.path);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("reclaims space from deleted rows and preserves the survivors", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, body TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (id, body) VALUES (?, ?)");
    for (let i = 1; i <= 500; i++) insert.run(i, `row-${i}-${"x".repeat(40)}`);
    db.exec("DELETE FROM t WHERE id > 5");

    const { pagesBefore, pagesAfter } = db.vacuum();
    expect(pagesAfter).toBeLessThan(pagesBefore);

    expect(db.prepare("SELECT id FROM t ORDER BY id").values()).toEqual([
      [1n],
      [2n],
      [3n],
      [4n],
      [5n],
    ]);
    expect(db.prepare("SELECT body FROM t WHERE id = ?").pluck(3)).toBe(`row-3-${"x".repeat(40)}`);
  });

  it("reclaims dead overflow chains", () => {
    db.exec("CREATE TABLE blobs (id INT PRIMARY KEY, data BLOB NOT NULL)");
    const big = Buffer.alloc(120_000, 7);
    const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
    for (let i = 1; i <= 8; i++) insert.run(i, big);
    db.exec("DELETE FROM blobs"); // all rows + their overflow chains become dead

    const { pagesBefore, pagesAfter } = db.vacuum();
    expect(pagesAfter).toBeLessThan(pagesBefore / 2); // hundreds of overflow pages freed
    expect(db.prepare("SELECT id FROM blobs").values()).toEqual([]);
  });

  it("preserves constraints, indexes, defaults, and AUTOINCREMENT", () => {
    db.exec(
      "CREATE TABLE u (id INT PRIMARY KEY AUTOINCREMENT, email INT UNIQUE, role TEXT DEFAULT 'member')",
    );
    db.exec("CREATE TABLE other (id INT PRIMARY KEY, u INT NOT NULL)");
    db.exec("CREATE INDEX ON other (u)");
    db.prepare("INSERT INTO u (email) VALUES (?)").run(10);
    db.prepare("INSERT INTO u (email) VALUES (?)").run(20);

    db.vacuum();

    // DEFAULT still applies, UNIQUE still enforced, PK index still used.
    db.exec("INSERT INTO u (email) VALUES (30)");
    expect(db.prepare("SELECT role FROM u WHERE email = ?").pluck(30)).toBe("member");
    expect(() => db.exec("INSERT INTO u (email) VALUES (10)")).toThrow(ConstraintError);

    // AUTOINCREMENT continues from the max id carried over (3 rows -> next is 4).
    db.exec("INSERT INTO u (email) VALUES (40)");
    expect(db.prepare("SELECT id FROM u WHERE email = ?").pluck(40)).toBe(4n);

    // The secondary index on other(u) survived.
    const plan = db.exec("EXPLAIN SELECT id FROM other WHERE u = 1");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });

  it("runs via the SQL VACUUM statement and reports page counts", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY)");
    for (let i = 1; i <= 100; i++) db.prepare("INSERT INTO t (id) VALUES (?)").run(i);
    db.exec("DELETE FROM t WHERE id > 10");

    const r = db.exec("VACUUM");
    expect(r.type).toBe("vacuum");
    if (r.type === "vacuum") expect(r.pagesAfter).toBeLessThanOrEqual(r.pagesBefore);
  });

  it("persists the compacted database across a reopen", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL)");
    for (let i = 1; i <= 50; i++) db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(i, i * 2);
    db.exec("DELETE FROM t WHERE id > 3");
    db.vacuum();
    db.close();

    db = reopen();
    expect(db.prepare("SELECT id, v FROM t ORDER BY id").values()).toEqual([
      [1n, 2n],
      [2n, 4n],
      [3n, 6n],
    ]);
  });

  it("refuses to VACUUM inside an explicit transaction", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY)");
    db.exec("BEGIN");
    expect(() => db.vacuum()).toThrow(TransactionError);
    expect(() => db.exec("VACUUM")).toThrow(TransactionError);
    db.exec("ROLLBACK");
  });
});
