import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { CatalogError, TransactionError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("DROP / ALTER / backup / dump", () => {
  let tmp: TempDb;
  let db: Database;
  const extras: string[] = [];

  const sidecar = (suffix: string): string => {
    const p = `${tmp.path}-${suffix}`;
    extras.push(p);
    return p;
  };
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
    for (const p of extras.splice(0)) {
      for (const s of ["", "-wal", "-lock"]) rmSync(`${p}${s}`, { force: true });
    }
  });

  it("drops a table and frees its name", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY)");
    db.exec("INSERT INTO t (id) VALUES (1)");
    db.exec("DROP TABLE t");
    expect(db.tableNames()).not.toContain("t");
    expect(() => db.exec("SELECT id FROM t")).toThrow(CatalogError);

    db.exec("CREATE TABLE t (id INT PRIMARY KEY, n INT)"); // name is free again
    expect(db.tableNames()).toContain("t");

    expect(() => db.exec("DROP TABLE missing")).toThrow(CatalogError);
    db.exec("DROP TABLE IF EXISTS missing"); // no-op, no throw
  });

  it("drops a secondary index but not a constraint-backed one", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, age INT)");
    db.exec("CREATE INDEX ON t (age)");
    for (let i = 1; i <= 20; i++) db.prepare("INSERT INTO t (id, age) VALUES (?, ?)").run(i, i % 5);

    expect(db.exec("EXPLAIN SELECT id FROM t WHERE age = 2")).toMatchObject({ type: "explain" });
    db.exec("DROP INDEX ON t (age)");
    const plan = db.exec("EXPLAIN SELECT id FROM t WHERE age = 2");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("SeqScan");

    // The PK's unique index cannot be dropped.
    expect(() => db.exec("DROP INDEX ON t (id)")).toThrow(CatalogError);
  });

  it("adds a column with a DEFAULT, backfilling existing rows", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "ann");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(2, "bob");

    db.exec("ALTER TABLE t ADD COLUMN active BOOL DEFAULT TRUE");
    db.exec("ALTER TABLE t ADD COLUMN nickname TEXT"); // nullable, no default

    expect(db.prepare("SELECT id, active, nickname FROM t ORDER BY id").values()).toEqual([
      [1n, true, null],
      [2n, true, null],
    ]);
    db.prepare("INSERT INTO t (id, name, nickname) VALUES (?, ?, ?)").run(3, "cleo", "C");
    expect(db.prepare("SELECT active, nickname FROM t WHERE id = ?").get(3)).toEqual({
      active: true,
      nickname: "C",
    });
  });

  it("persists ALTER across a reopen and rejects invalid ADD COLUMN", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY)");
    db.exec("INSERT INTO t (id) VALUES (1)");
    db.exec("ALTER TABLE t ADD COLUMN score INT DEFAULT 0");
    db.close();

    db = reopen();
    expect(db.prepare("SELECT score FROM t WHERE id = ?").pluck(1)).toBe(0n);
    expect(() => db.exec("ALTER TABLE t ADD COLUMN k INT NOT NULL")).toThrow(CatalogError); // no default
    expect(() => db.exec("ALTER TABLE t ADD COLUMN u INT UNIQUE")).toThrow(CatalogError);
  });

  it("makes a consistent online backup", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL)");
    for (let i = 1; i <= 30; i++) db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(i, i * i);

    const backupPath = sidecar("backup");
    db.backup(backupPath);

    const copy = Database.open(backupPath);
    expect(copy.prepare("SELECT v FROM t WHERE id = ?").pluck(5)).toBe(25n);
    expect(copy.prepare("SELECT COUNT(*) FROM t").pluck()).toBe(30n);
    copy.close();

    // The original is still usable and unchanged.
    expect(db.prepare("SELECT COUNT(*) FROM t").pluck()).toBe(30n);
  });

  it("dumps to SQL that round-trips every type", () => {
    db.exec(
      "CREATE TABLE m (id INT PRIMARY KEY, name TEXT NOT NULL, ratio REAL, data BLOB, at DATETIME, n INT)",
    );
    const when = new Date("2024-05-01T10:00:00.000Z");
    db.prepare("INSERT INTO m (id, name, ratio, data, at, n) VALUES (?, ?, ?, ?, ?, ?)").run(
      1,
      "o'brien",
      3.5,
      Buffer.from([1, 2, 3]),
      when,
      9,
    );
    db.exec("CREATE INDEX ON m (n)");

    const sql = db.dump();
    expect(sql).toContain("CREATE TABLE m");
    expect(sql).toContain("CREATE INDEX ON m (n)");
    expect(sql).toContain("'o''brien'"); // escaped quote

    const restorePath = sidecar("restore");
    const restored = Database.open(restorePath);
    restored.execMany(sql);
    const row = restored.prepare("SELECT name, ratio, data, at FROM m WHERE id = ?").get(1);
    expect(row!.name).toBe("o'brien");
    expect(row!.ratio).toBe(3.5);
    expect(row!.data).toEqual(Buffer.from([1, 2, 3]));
    expect((row!.at as Date).getTime()).toBe(when.getTime());
    restored.close();
  });

  it("forbids DDL inside an explicit transaction", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY)");
    db.exec("BEGIN");
    expect(() => db.exec("DROP TABLE t")).toThrow(TransactionError);
    expect(() => db.exec("ALTER TABLE t ADD COLUMN x INT")).toThrow(TransactionError);
    db.exec("ROLLBACK");
  });
});
