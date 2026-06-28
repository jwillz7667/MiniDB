import { appendFileSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../../src/db.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

/**
 * "Crash" = abandon a Database without closing it, so its dirty pages and any
 * unflushed WAL buffer are lost, exactly as a `kill -9` would leave things. A
 * fresh open on the same files must recover to the last consistent state.
 */
describe("crash recovery", () => {
  let tmp: TempDb;
  // A crash kills the process, so its lock becomes stale and the next process
  // reclaims it. In-process we model that by clearing the lock before reopening.
  const open = (): Database => {
    rmSync(`${tmp.path}-lock`, { force: true });
    return Database.open(tmp.path);
  };
  const ids = (db: Database, sql: string): bigint[] => {
    const r = db.exec(sql);
    if (r.type !== "select") throw new Error("expected select");
    return (r.rows as bigint[][]).map((row) => row[0]!);
  };

  beforeEach(() => {
    tmp = makeTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("keeps committed rows and drops uncommitted ones after a crash", () => {
    const db1 = open();
    db1.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
    db1.exec("INSERT INTO t (id, n) VALUES (1, 10), (2, 20), (3, 30)"); // committed

    db1.exec("BEGIN");
    db1.exec("INSERT INTO t (id, n) VALUES (4, 40), (5, 50)"); // never committed
    // crash: do not COMMIT, do not close.

    const db2 = open();
    expect(ids(db2, "SELECT id FROM t ORDER BY id")).toEqual([1n, 2n, 3n]);
    db2.close();
  });

  it("undoes a stolen (flushed) uncommitted transaction via before-images", () => {
    const db1 = open();
    db1.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
    db1.exec("INSERT INTO t (id, n) VALUES (1, 10), (2, 20), (3, 30)");

    db1.exec("BEGIN");
    db1.exec("INSERT INTO t (id, n) VALUES (4, 40), (5, 50)");
    // Force the uncommitted pages AND their log to disk (STEAL), then crash.
    db1.checkpoint();

    const db2 = open();
    expect(db2.recoveryStats().undone).toBeGreaterThan(0); // undo actually ran
    expect(ids(db2, "SELECT id FROM t ORDER BY id")).toEqual([1n, 2n, 3n]);
    db2.close();
  });

  it("tolerates a torn trailing write in the WAL", () => {
    const db1 = open();
    db1.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
    db1.exec("INSERT INTO t (id, n) VALUES (1, 10), (2, 20), (3, 30)"); // committed, flushed
    // crash, then a partial frame lands at the tail of the WAL.
    appendFileSync(tmp.walPath, Buffer.from([0x40, 0x00, 0x00, 0x00, 0xde, 0xad]));

    const db2 = open();
    expect(ids(db2, "SELECT id FROM t ORDER BY id")).toEqual([1n, 2n, 3n]);
    db2.close();
  });

  it("replays only from the last checkpoint forward", () => {
    const db1 = open();
    db1.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
    db1.exec("INSERT INTO t (id, n) VALUES (1, 10), (2, 20)");
    db1.checkpoint(); // batch 1 now lives in the data file
    db1.exec("INSERT INTO t (id, n) VALUES (3, 30), (4, 40)"); // committed after checkpoint
    // crash.

    const db2 = open();
    const stats = db2.recoveryStats();
    expect(stats.redoStartLsn).toBeGreaterThan(0n); // redo skipped the pre-checkpoint prefix
    expect(ids(db2, "SELECT id FROM t ORDER BY id")).toEqual([1n, 2n, 3n, 4n]);
    db2.close();
  });

  it("does not let an aborted transaction clobber a later committed write (crash)", () => {
    const db1 = open();
    db1.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
    db1.checkpoint();

    db1.exec("BEGIN");
    db1.exec("INSERT INTO t (id, n) VALUES (1, 10)");
    db1.exec("ROLLBACK"); // aborted T1 — its UPDATE records are durable in the WAL

    // A committed transaction now rewrites the same heap-header bytes T1 touched.
    db1.exec("INSERT INTO t (id, n) VALUES (2, 20)");
    // crash.

    const db2 = open();
    // The committed row must survive; recovery must NOT undo the aborted T1.
    expect(ids(db2, "SELECT id FROM t ORDER BY id")).toEqual([2n]);
    db2.close();
  });

  it("does not let an aborted transaction clobber a committed write (clean reopen)", () => {
    const db1 = open();
    db1.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
    db1.exec("BEGIN");
    db1.exec("INSERT INTO t (id, n) VALUES (1, 10)");
    db1.exec("ROLLBACK");
    db1.exec("INSERT INTO t (id, n) VALUES (2, 20)");
    db1.close(); // clean shutdown (checkpoint keeps the whole WAL, including the abort)

    const db2 = open();
    expect(ids(db2, "SELECT id FROM t ORDER BY id")).toEqual([2n]);
    db2.close();
  });

  it("recovers an index so post-crash index scans stay correct", () => {
    const db1 = open();
    db1.exec("CREATE TABLE t (id INT NOT NULL, age INT NOT NULL)");
    db1.exec("CREATE INDEX ON t (age)");
    for (let i = 0; i < 200; i++) db1.exec(`INSERT INTO t (id, age) VALUES (${i}, ${i % 10})`);
    // crash without closing.

    const db2 = open();
    const viaIndex = ids(db2, "SELECT id FROM t WHERE age = 7 ORDER BY id");
    expect(viaIndex).toHaveLength(20);
    const plan = db2.exec("EXPLAIN SELECT * FROM t WHERE age = 7");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
    db2.close();
  });
});
