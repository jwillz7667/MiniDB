import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { PlanError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("REAL / BLOB / DATETIME column types", () => {
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

  it("round-trips REAL via literals and params", () => {
    db.exec("CREATE TABLE m (id INT NOT NULL, r REAL NOT NULL)");
    db.exec("INSERT INTO m (id, r) VALUES (1, 3.14), (2, -2.5), (3, 1e3)");
    db.prepare("INSERT INTO m (id, r) VALUES (?, ?)").run(4, 0.001);

    expect(db.prepare("SELECT r FROM m ORDER BY id").values()).toEqual([[3.14], [-2.5], [1000], [0.001]]);
    // ORDER BY orders REALs numerically.
    expect(db.prepare("SELECT id FROM m ORDER BY r").values()).toEqual([[2n], [4n], [1n], [3n]]);
  });

  it("applies numeric affinity between INT and REAL in comparisons", () => {
    db.exec("CREATE TABLE m (id INT NOT NULL, r REAL NOT NULL)");
    db.exec("INSERT INTO m (id, r) VALUES (1, 0.5), (2, 5.0), (3, 9.9)");

    // An integer literal compares against REAL values without an explicit cast.
    expect(db.prepare("SELECT id FROM m WHERE r > 1 ORDER BY id").values()).toEqual([[2n], [3n]]);
    expect(db.prepare("SELECT id FROM m WHERE r = ? ORDER BY id").values(5)).toEqual([[2n]]);
  });

  it("round-trips BLOB via X'..' literals and Buffer params", () => {
    db.exec("CREATE TABLE m (id INT NOT NULL, b BLOB)");
    db.exec("INSERT INTO m (id, b) VALUES (1, X'48656c6c6f')"); // "Hello"
    db.prepare("INSERT INTO m (id, b) VALUES (?, ?)").run(2, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    db.exec("INSERT INTO m (id, b) VALUES (3, NULL)");

    const rows = db.prepare("SELECT b FROM m ORDER BY id").values();
    expect(rows[0]![0]).toEqual(Buffer.from("Hello"));
    expect(rows[1]![0]).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(rows[2]![0]).toBeNull();
  });

  it("round-trips DATETIME via Date params and epoch-millis literals", () => {
    db.exec("CREATE TABLE e (id INT NOT NULL, at DATETIME NOT NULL)");
    const t1 = new Date("2024-01-01T00:00:00.000Z");
    const t2 = new Date("2025-06-15T12:30:00.000Z");
    db.prepare("INSERT INTO e (id, at) VALUES (?, ?)").run(1, t1);
    db.prepare("INSERT INTO e (id, at) VALUES (?, ?)").run(2, t2);
    db.exec(`INSERT INTO e (id, at) VALUES (3, ${new Date("2023-03-03T03:03:03.000Z").getTime()})`);

    const at = db.prepare("SELECT at FROM e WHERE id = ?").pluck(1);
    expect(at).toBeInstanceOf(Date);
    expect((at as Date).getTime()).toBe(t1.getTime());

    // Comparison + ORDER BY work on DATETIME when bound as a Date.
    const after = db
      .prepare("SELECT id FROM e WHERE at > ? ORDER BY at")
      .values(new Date("2024-06-01T00:00:00.000Z"));
    expect(after).toEqual([[2n]]);
    expect(db.prepare("SELECT id FROM e ORDER BY at").values()).toEqual([[3n], [1n], [2n]]);
  });

  it("updates REAL, BLOB, and DATETIME values", () => {
    db.exec("CREATE TABLE m (id INT NOT NULL, r REAL NOT NULL, b BLOB, at DATETIME)");
    db.prepare("INSERT INTO m (id, r, b, at) VALUES (?, ?, ?, ?)").run(1, 1.0, Buffer.from("x"), null);

    const when = new Date("2030-12-31T23:59:59.000Z");
    db.prepare("UPDATE m SET r = ?, b = ?, at = ? WHERE id = ?").run(2.71, Buffer.from("yz"), when, 1);

    const row = db.prepare("SELECT r, b, at FROM m WHERE id = ?").get(1);
    expect(row!.r).toBe(2.71);
    expect(row!.b).toEqual(Buffer.from("yz"));
    expect((row!.at as Date).getTime()).toBe(when.getTime());
  });

  it("persists all new types across a reopen", () => {
    db.exec("CREATE TABLE m (id INT NOT NULL, r REAL NOT NULL, b BLOB, at DATETIME)");
    const when = new Date("2024-02-29T00:00:00.000Z");
    db.prepare("INSERT INTO m (id, r, b, at) VALUES (?, ?, ?, ?)").run(1, 6.022, Buffer.from("nacl"), when);
    db.close();

    db = reopen();
    const row = db.prepare("SELECT r, b, at FROM m WHERE id = ?").get(1);
    expect(row!.r).toBe(6.022);
    expect(row!.b).toEqual(Buffer.from("nacl"));
    expect((row!.at as Date).getTime()).toBe(when.getTime());
  });

  it("rejects values that no affinity can fit and non-INT indexes", () => {
    db.exec("CREATE TABLE m (id INT NOT NULL, r REAL NOT NULL, b BLOB)");
    expect(() => db.exec("INSERT INTO m (id, r) VALUES (1, 'not a number')")).toThrow(PlanError);
    expect(() => db.prepare("INSERT INTO m (id, r) VALUES (?, ?)").run(1, "nope")).toThrow(PlanError);
    // Secondary indexes remain INT-only (B+Tree keys are 64-bit integers).
    db.exec("INSERT INTO m (id, r) VALUES (1, 1.0)");
    expect(() => db.exec("CREATE INDEX ON m (r)")).toThrow(/INT/);
  });

  it("parses negative float literals", () => {
    db.exec("CREATE TABLE m (id INT NOT NULL, r REAL NOT NULL)");
    db.exec("INSERT INTO m (id, r) VALUES (1, -0.25)");
    expect(db.prepare("SELECT r FROM m WHERE id = ?").pluck(1)).toBe(-0.25);
  });
});
