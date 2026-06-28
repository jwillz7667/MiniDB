import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { PlanError, TupleError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("UPDATE", () => {
  let tmp: TempDb;
  let db: Database;

  const reopen = (): Database => {
    rmSync(`${tmp.path}-lock`, { force: true });
    return Database.open(tmp.path);
  };
  const ids = (sql: string, ...params: (bigint | number | string | boolean | null)[]): bigint[] =>
    db.prepare(sql).values(...params).map((r) => r[0] as bigint);

  beforeEach(() => {
    tmp = makeTempDb();
    db = Database.open(tmp.path);
    db.exec("CREATE TABLE t (id INT NOT NULL, v INT NOT NULL, body TEXT)");
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("updates matching rows and reports the count", () => {
    db.exec("INSERT INTO t (id, v, body) VALUES (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c')");

    const r = db.exec("UPDATE t SET v = 99 WHERE id = 2");
    expect(r).toEqual({ type: "update", rowCount: 1 });
    expect(db.prepare("SELECT v FROM t ORDER BY id").values()).toEqual([[10n], [99n], [30n]]);
  });

  it("updates every row when there is no WHERE", () => {
    db.exec("INSERT INTO t (id, v) VALUES (1, 1), (2, 2), (3, 3)");
    expect(db.run("UPDATE t SET v = ?", [7]).changes).toBe(3);
    expect(db.prepare("SELECT v FROM t ORDER BY id").values()).toEqual([[7n], [7n], [7n]]);
  });

  it("binds placeholders in SET and WHERE", () => {
    db.exec("INSERT INTO t (id, v, body) VALUES (1, 1, 'x'), (2, 2, 'y')");
    db.prepare("UPDATE t SET v = ?, body = ? WHERE id = ?").run(50, "z", 2);
    expect(db.prepare("SELECT v, body FROM t WHERE id = ?").get(2)).toEqual({ v: 50n, body: "z" });
  });

  it("assigns one column from another column's current value", () => {
    db.exec("INSERT INTO t (id, v) VALUES (1, 100), (2, 200)");
    db.exec("UPDATE t SET id = v"); // id := v
    expect(db.prepare("SELECT id, v FROM t ORDER BY v").values()).toEqual([
      [100n, 100n],
      [200n, 200n],
    ]);
  });

  it("keeps a secondary index correct after an in-place (same-length) update", () => {
    db.exec("CREATE INDEX ON t (v)");
    db.exec("INSERT INTO t (id, v) VALUES (1, 5), (2, 5), (3, 7)");

    db.exec("UPDATE t SET v = 9 WHERE id = 1");

    expect(ids("SELECT id FROM t WHERE v = 5 ORDER BY id")).toEqual([2n]);
    expect(ids("SELECT id FROM t WHERE v = 9 ORDER BY id")).toEqual([1n]);
    expect(ids("SELECT id FROM t WHERE v = 7 ORDER BY id")).toEqual([3n]);
    const plan = db.exec("EXPLAIN SELECT * FROM t WHERE v = 9");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });

  it("re-points an index entry when a length change relocates the row", () => {
    db.exec("CREATE INDEX ON t (id)");
    db.exec("INSERT INTO t (id, v, body) VALUES (1, 1, 'a'), (2, 2, 'b'), (3, 3, 'c')");

    // Growing the TEXT changes the tuple length, forcing a heap relocation (new
    // rid). The INT index key is unchanged but its entry must follow the new rid.
    db.exec("UPDATE t SET body = 'a much longer body that changes the row length' WHERE id = 2");

    const row = db.prepare("SELECT id, v, body FROM t WHERE id = ?").get(2); // index lookup
    expect(row).toEqual({ id: 2n, v: 2n, body: "a much longer body that changes the row length" });
    expect(ids("SELECT id FROM t ORDER BY id")).toEqual([1n, 2n, 3n]);
  });

  it("updates each matched row exactly once even when rows relocate (no Halloween)", () => {
    for (let i = 0; i < 50; i++) db.exec(`INSERT INTO t (id, v, body) VALUES (${i}, ${i}, 's')`);

    // Each row grows, relocating to the tail; a naive scan would re-encounter and
    // re-update the moved rows. Materializing the target set first prevents that.
    const changed = db.run("UPDATE t SET body = 'a substantially longer body value'").changes;
    expect(changed).toBe(50);
    expect(ids("SELECT id FROM t").length).toBe(50);
    expect(db.prepare("SELECT body FROM t WHERE id = ?").pluck(25)).toBe(
      "a substantially longer body value",
    );
  });

  it("rolls back an update, restoring values and indexes", () => {
    db.exec("CREATE INDEX ON t (v)");
    db.exec("INSERT INTO t (id, v) VALUES (1, 10), (2, 20)");

    db.exec("BEGIN");
    db.exec("UPDATE t SET v = 999 WHERE id = 1");
    expect(ids("SELECT id FROM t WHERE v = 999")).toEqual([1n]); // visible inside txn
    db.exec("ROLLBACK");

    expect(db.prepare("SELECT v FROM t ORDER BY id").values()).toEqual([[10n], [20n]]);
    expect(ids("SELECT id FROM t WHERE v = 10")).toEqual([1n]);
    expect(ids("SELECT id FROM t WHERE v = 999")).toEqual([]);
  });

  it("persists a committed update across a clean reopen", () => {
    db.exec("INSERT INTO t (id, v) VALUES (1, 1), (2, 2)");
    db.exec("UPDATE t SET v = 42 WHERE id = 1");
    db.close();

    db = reopen();
    expect(db.prepare("SELECT v FROM t ORDER BY id").values()).toEqual([[42n], [2n]]);
  });

  it("recovers a committed update after a crash (abandoned process)", () => {
    db.exec("INSERT INTO t (id, v) VALUES (1, 1), (2, 2)");
    db.exec("UPDATE t SET v = 77 WHERE id = 2");
    // Abandon db without closing — its lock goes stale, like a real crash.

    db = reopen();
    expect(db.prepare("SELECT v FROM t ORDER BY id").values()).toEqual([[1n], [77n]]);
  });

  it("rejects unknown columns and NOT NULL violations", () => {
    db.exec("INSERT INTO t (id, v) VALUES (1, 1)");
    expect(() => db.exec("UPDATE t SET nope = 1")).toThrow(TupleError); // unknown column
    expect(() => db.exec("UPDATE t SET v = NULL")).toThrow(TupleError); // v is NOT NULL
    expect(() => db.exec("UPDATE t SET v = 1, v = 2")).toThrow(PlanError); // dup assignment
  });
});
