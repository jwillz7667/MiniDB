import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { CatalogError, ConstraintError, PlanError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("column constraints", () => {
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

  it("enforces PRIMARY KEY uniqueness and NOT NULL", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "a");

    expect(() => db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "b")).toThrow(
      ConstraintError,
    );
    expect(() => db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(null, "c")).toThrow(
      PlanError, // NOT NULL is caught at plan time
    );
    // The failed inserts left nothing behind.
    expect(db.prepare("SELECT id, name FROM t").values()).toEqual([[1n, "a"]]);
  });

  it("enforces UNIQUE but allows multiple NULLs", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY AUTOINCREMENT, tag INT UNIQUE)");
    const insert = db.prepare("INSERT INTO t (tag) VALUES (?)");
    insert.run(5);
    expect(() => insert.run(5)).toThrow(ConstraintError);

    insert.run(null); // NULLs are distinct under UNIQUE
    insert.run(null);
    expect(db.prepare("SELECT tag FROM t ORDER BY id").values()).toEqual([[5n], [null], [null]]);
    expect(db.prepare("SELECT tag FROM t WHERE tag = ?").values(5)).toEqual([[5n]]);
  });

  it("enforces UNIQUE on UPDATE, but lets a row keep its own value", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, code INT UNIQUE)");
    const insert = db.prepare("INSERT INTO t (id, code) VALUES (?, ?)");
    insert.run(1, 100);
    insert.run(2, 200);

    expect(() => db.prepare("UPDATE t SET code = ? WHERE id = ?").run(200, 1)).toThrow(
      ConstraintError,
    );
    db.prepare("UPDATE t SET code = ?, id = id WHERE id = ?").run(100, 1); // self value: ok
    db.prepare("UPDATE t SET code = ? WHERE id = ?").run(300, 1); // free value: ok
    expect(db.prepare("SELECT code FROM t ORDER BY id").values()).toEqual([[300n], [200n]]);
  });

  it("applies DEFAULT values when columns are omitted", () => {
    db.exec(
      "CREATE TABLE t (id INT PRIMARY KEY AUTOINCREMENT, n INT DEFAULT 7, s TEXT DEFAULT 'hi', " +
        "r REAL DEFAULT 1.5, active BOOL DEFAULT TRUE)",
    );
    db.exec("INSERT INTO t (id) VALUES (1)");
    db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run(2, 99);

    expect(db.prepare("SELECT n, s, r, active FROM t WHERE id = ?").get(1)).toEqual({
      n: 7n,
      s: "hi",
      r: 1.5,
      active: true,
    });
    expect(db.prepare("SELECT n FROM t WHERE id = ?").pluck(2)).toBe(99n);
  });

  it("auto-assigns AUTOINCREMENT ids, respecting explicit values", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
    insert.run("a");
    insert.run("b");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(100, "c"); // explicit
    insert.run("d"); // next is max + 1 = 101

    expect(db.prepare("SELECT id, name FROM t ORDER BY id").values()).toEqual([
      [1n, "a"],
      [2n, "b"],
      [100n, "c"],
      [101n, "d"],
    ]);
  });

  it("continues AUTOINCREMENT from the persisted maximum after reopen", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");
    db.prepare("INSERT INTO t (name) VALUES (?)").run("a");
    db.prepare("INSERT INTO t (name) VALUES (?)").run("b");
    db.close();

    db = reopen();
    db.prepare("INSERT INTO t (name) VALUES (?)").run("c");
    expect(db.prepare("SELECT id FROM t ORDER BY id").values()).toEqual([[1n], [2n], [3n]]);
  });

  it("uses the PRIMARY KEY index for point lookups", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL)");
    for (let i = 1; i <= 100; i++) db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(i, `n${i}`);
    expect(db.prepare("SELECT name FROM t WHERE id = ?").pluck(42)).toBe("n42");
    const plan = db.exec("EXPLAIN SELECT name FROM t WHERE id = 42");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });

  it("persists DEFAULT metadata and unique constraints across reopen", () => {
    db.exec("CREATE TABLE t (id INT PRIMARY KEY, code INT UNIQUE, note TEXT DEFAULT 'none')");
    db.prepare("INSERT INTO t (id, code) VALUES (?, ?)").run(1, 10);
    db.close();

    db = reopen();
    db.exec("INSERT INTO t (id, code) VALUES (2, 20)"); // default applied
    expect(db.prepare("SELECT note FROM t WHERE id = ?").pluck(2)).toBe("none");
    expect(() => db.exec("INSERT INTO t (id, code) VALUES (3, 10)")).toThrow(ConstraintError);
  });

  it("rejects unsupported constraint declarations at CREATE TABLE", () => {
    expect(() => db.exec("CREATE TABLE a (k TEXT PRIMARY KEY)")).toThrow(CatalogError); // non-INT PK
    expect(() => db.exec("CREATE TABLE b (k TEXT UNIQUE)")).toThrow(CatalogError); // non-INT UNIQUE
    expect(() => db.exec("CREATE TABLE c (k INT AUTOINCREMENT)")).toThrow(CatalogError); // not PK
    expect(() => db.exec("CREATE TABLE d (a INT PRIMARY KEY, b INT PRIMARY KEY)")).toThrow(
      CatalogError,
    ); // two PKs
    expect(() => db.exec("CREATE TABLE e (id INT NOT NULL DEFAULT NULL)")).toThrow(CatalogError);
  });

  it("rejects a type-incompatible DEFAULT at CREATE TABLE", () => {
    expect(() => db.exec("CREATE TABLE t (id INT PRIMARY KEY, n INT DEFAULT 'oops')")).toThrow(
      CatalogError,
    );
  });
});
