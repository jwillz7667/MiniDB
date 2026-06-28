import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { TransactionError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

function rows(r: ReturnType<Database["exec"]>): bigint[][] {
  if (r.type !== "select") throw new Error(`expected select, got ${r.type}`);
  return r.rows as bigint[][];
}

describe("Database (durable path)", () => {
  let tmp: TempDb;
  let db: Database;

  beforeEach(() => {
    tmp = makeTempDb();
    db = Database.open(tmp.path);
    db.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("runs basic CRUD through the WAL-backed path", () => {
    db.exec("INSERT INTO t (id, n) VALUES (1, 10), (2, 20), (3, 30)");
    expect(rows(db.exec("SELECT id FROM t ORDER BY id"))).toEqual([[1n], [2n], [3n]]);

    db.exec("DELETE FROM t WHERE id = 2");
    expect(rows(db.exec("SELECT id FROM t ORDER BY id"))).toEqual([[1n], [3n]]);
  });

  it("commits an explicit transaction durably", () => {
    db.exec("BEGIN");
    db.exec("INSERT INTO t (id, n) VALUES (1, 10)");
    db.exec("INSERT INTO t (id, n) VALUES (2, 20)");
    db.exec("COMMIT");
    expect(rows(db.exec("SELECT id FROM t ORDER BY id"))).toEqual([[1n], [2n]]);
  });

  it("rolls an explicit transaction back to nothing", () => {
    db.exec("INSERT INTO t (id, n) VALUES (1, 10)");
    db.exec("BEGIN");
    db.exec("INSERT INTO t (id, n) VALUES (2, 20)");
    db.exec("INSERT INTO t (id, n) VALUES (3, 30)");
    db.exec("ROLLBACK");
    expect(rows(db.exec("SELECT id FROM t ORDER BY id"))).toEqual([[1n]]);
  });

  it("forbids DDL inside an explicit transaction and double BEGIN", () => {
    db.exec("BEGIN");
    expect(() => db.exec("CREATE TABLE x (a INT NOT NULL)")).toThrow(TransactionError);
    expect(() => db.exec("BEGIN")).toThrow(TransactionError);
    db.exec("ROLLBACK");
    expect(() => db.exec("COMMIT")).toThrow(TransactionError); // nothing to commit
  });

  it("keeps the heap chain reachable after rolling back chain growth", () => {
    db.exec("CREATE TABLE big (id INT NOT NULL, body TEXT)");
    const body = "x".repeat(300); // a few dozen rows per page -> forces new pages

    db.exec("BEGIN");
    for (let i = 0; i < 200; i++) db.exec(`INSERT INTO big (id, body) VALUES (${i}, '${body}')`);
    db.exec("ROLLBACK"); // undoes the inserts AND the page-chain growth

    // New rows must land on a page still reachable from the heap root.
    db.exec("INSERT INTO big (id, body) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    const r = db.exec("SELECT id FROM big ORDER BY id");
    expect(r.type === "select" && r.rows).toEqual([[1n], [2n], [3n]]);
  });

  it("persists across a clean close and reopen", () => {
    db.exec("CREATE INDEX ON t (n)");
    db.exec("INSERT INTO t (id, n) VALUES (1, 100), (2, 200), (3, 200)");
    db.close();

    db = Database.open(tmp.path);
    expect(db.tableNames()).toContain("t");
    expect(rows(db.exec("SELECT id FROM t WHERE n = 200 ORDER BY id"))).toEqual([[2n], [3n]]);
    // The index survived: EXPLAIN still chooses it.
    const plan = db.exec("EXPLAIN SELECT * FROM t WHERE n = 200");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });
});
