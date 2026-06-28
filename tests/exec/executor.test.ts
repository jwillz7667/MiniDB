import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PlanError } from "../../src/errors.js";
import { makeEngine, type TestEngine } from "../helpers/engine.js";

describe("end-to-end SQL execution", () => {
  let db: TestEngine;

  beforeEach(() => {
    db = makeEngine();
    db.exec("CREATE TABLE users (id INT NOT NULL, name TEXT, age INT NOT NULL, active BOOL)");
    for (let i = 0; i < 300; i++) {
      db.exec(
        `INSERT INTO users (id, name, age, active) VALUES (${i}, 'user${i}', ${20 + (i % 50)}, ${
          i % 2 === 0 ? "TRUE" : "FALSE"
        })`,
      );
    }
  });

  afterEach(() => {
    db.cleanup();
  });

  it("runs WHERE + ORDER BY + LIMIT and returns rows in order", () => {
    const rows = db.query(
      "SELECT id, age FROM users WHERE age >= 60 ORDER BY id ASC LIMIT 5",
    );
    expect(rows.length).toBe(5);
    // age = 20 + (i % 50) >= 60 means i % 50 in [40, 49]; smallest such ids are 40..44.
    expect(rows.map((r) => r[0])).toEqual([40n, 41n, 42n, 43n, 44n]);
    expect(rows.every((r) => (r[1] as bigint) >= 60n)).toBe(true);
  });

  it("sorts DESC and projects a subset of columns", () => {
    const rows = db.query("SELECT age FROM users ORDER BY age DESC LIMIT 10");
    expect(rows).toHaveLength(10);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i]![0] as bigint) <= (rows[i - 1]![0] as bigint)).toBe(true);
    }
    expect(rows[0]![0]).toBe(69n); // max age = 20 + 49
  });

  it("evaluates AND / OR predicates with correct precedence", () => {
    const rows = db.query(
      "SELECT id FROM users WHERE age = 20 AND active = TRUE OR age = 21 ORDER BY id",
    );
    // (age = 20 AND active) OR age = 21. age=20 -> i%50==0 -> i in {0,50,100,...}; of those active (even i): all are even -> all qualify.
    // age=21 -> i%50==1 -> i in {1,51,101,...}.
    const ids = rows.map((r) => r[0] as bigint);
    expect(ids).toContain(0n);
    expect(ids).toContain(1n);
    expect(ids).not.toContain(2n);
  });

  it("EXPLAIN shows SeqScan without an index and IndexScan with one, same results", () => {
    const plain = db.exec("EXPLAIN SELECT * FROM users WHERE age = 35");
    expect(plain.type).toBe("explain");
    const planLines = plain.type === "explain" ? plain.lines.join("\n") : "";
    expect(planLines).toContain("SeqScan users");
    expect(planLines).toContain("Filter age = 35");

    const before = db.query("SELECT id FROM users WHERE age = 35 ORDER BY id");

    db.exec("CREATE INDEX ON users (age)");
    const indexed = db.exec("EXPLAIN SELECT * FROM users WHERE age = 35");
    const indexedLines = indexed.type === "explain" ? indexed.lines.join("\n") : "";
    expect(indexedLines).toContain("IndexScan users.age [35, 35]");
    expect(indexedLines).not.toContain("SeqScan");

    const after = db.query("SELECT id FROM users WHERE age = 35 ORDER BY id");
    expect(after).toEqual(before); // identical results either way
    expect(after.length).toBeGreaterThan(0);
  });

  it("pushes one conjunct into an IndexScan and keeps the rest as a Filter", () => {
    db.exec("CREATE INDEX ON users (age)");
    const r = db.exec("EXPLAIN SELECT * FROM users WHERE age = 30 AND active = TRUE");
    const lines = r.type === "explain" ? r.lines.join("\n") : "";
    expect(lines).toContain("IndexScan users.age [30, 30]");
    expect(lines).toContain("Filter active = TRUE");
  });

  it("uses an IndexScan for range predicates", () => {
    db.exec("CREATE INDEX ON users (age)");
    const r = db.exec("EXPLAIN SELECT id FROM users WHERE age > 65");
    const lines = r.type === "explain" ? r.lines.join("\n") : "";
    expect(lines).toContain("IndexScan users.age [66, +inf]");

    // age > 65 -> i % 50 in {46,47,48,49}: 4 per block of 50, 6 blocks over 300.
    const viaIndex = db.query("SELECT id FROM users WHERE age > 65 ORDER BY id");
    expect(viaIndex.length).toBe(24);
    expect(viaIndex.every(([id]) => 20 + (Number(id) % 50) > 65)).toBe(true);
  });

  it("DELETE WHERE removes the right rows and updates the index", () => {
    db.exec("CREATE INDEX ON users (age)");
    const before = db.query("SELECT id FROM users WHERE age = 25").length;
    expect(before).toBeGreaterThan(0);

    const del = db.exec("DELETE FROM users WHERE age = 25");
    expect(del.type === "delete" && del.rowCount).toBe(before);

    // Gone from both an index scan and a full scan.
    expect(db.query("SELECT id FROM users WHERE age = 25")).toHaveLength(0);
    expect(db.query("SELECT id FROM users").length).toBe(300 - before);
  });

  it("persists tables, rows and indexes across reopen", () => {
    db.exec("CREATE INDEX ON users (age)");
    const expected = db.query("SELECT id FROM users WHERE age = 40 ORDER BY id");

    const reopened = makeReopen(db);
    const after = reopened.query("SELECT id FROM users WHERE age = 40 ORDER BY id");
    expect(after).toEqual(expected);
    const plan = reopened.exec("EXPLAIN SELECT * FROM users WHERE age = 40");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });

  it("rejects type errors and unknown columns at plan time", () => {
    expect(() => db.exec("INSERT INTO users (id, age) VALUES ('x', 1)")).toThrow(PlanError);
    expect(() => db.exec("INSERT INTO users (id) VALUES (1)")).toThrow(PlanError); // age NOT NULL
    expect(() => db.exec("SELECT nope FROM users")).toThrow();
    expect(() => db.exec("CREATE INDEX ON users (name)")).toThrow(PlanError); // TEXT not indexable
  });
});

/** Reopen the engine, preserving its temp dir, and re-seed the local handle. */
function makeReopen(db: TestEngine): TestEngine {
  return db.reopen();
}
