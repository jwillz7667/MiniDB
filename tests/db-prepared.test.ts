import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { BindError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("prepared statements and parameter binding", () => {
  let tmp: TempDb;
  let db: Database;

  beforeEach(() => {
    tmp = makeTempDb();
    db = Database.open(tmp.path);
    db.exec("CREATE TABLE users (id INT NOT NULL, name TEXT NOT NULL, active BOOL NOT NULL)");
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("binds ? placeholders in INSERT and reads rows back as objects", () => {
    const insert = db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)");
    insert.run(1, "ann", true);
    insert.run(2, "bob", false);

    const all = db.prepare("SELECT id, name, active FROM users ORDER BY id").all();
    expect(all).toEqual([
      { id: 1n, name: "ann", active: true },
      { id: 2n, name: "bob", active: false },
    ]);
  });

  it("returns changes and lastInsertRowid from run()", () => {
    const r1 = db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(10, "x", true);
    expect(r1.changes).toBe(1);
    expect(r1.lastInsertRowid).toBe(1n); // first internal rowid

    const r2 = db
      .prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?), (?, ?, ?)")
      .run(11, "y", true, 12, "z", false);
    expect(r2.changes).toBe(2);
    expect(r2.lastInsertRowid).toBe(3n);
  });

  it("treats a bound value as data, not SQL (injection is impossible)", () => {
    db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(1, "ann", true);

    // A classic injection payload bound as a parameter matches nothing — it is a
    // literal string compared against the column, never parsed as SQL.
    const evil = "ann'; DROP TABLE users; --";
    const rows = db.prepare("SELECT id FROM users WHERE name = ?").all(evil);
    expect(rows).toEqual([]);

    // The table is untouched and the real value is still findable.
    expect(db.prepare("SELECT id FROM users WHERE name = ?").all("ann")).toEqual([{ id: 1n }]);
    expect(db.tableNames()).toContain("users");
  });

  it("reuses one prepared statement across many bindings", () => {
    const insert = db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)");
    for (let i = 1; i <= 5; i++) insert.run(i, `u${i}`, i % 2 === 0);

    const byId = db.prepare("SELECT name FROM users WHERE id = ?");
    expect(byId.get(3)).toEqual({ name: "u3" });
    expect(byId.get(5)).toEqual({ name: "u5" });
    expect(byId.get(99)).toBeUndefined();
  });

  it("supports get / values / pluck", () => {
    const insert = db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)");
    insert.run(1, "ann", true);
    insert.run(2, "bob", false);

    expect(db.prepare("SELECT id, name FROM users ORDER BY id").values()).toEqual([
      [1n, "ann"],
      [2n, "bob"],
    ]);
    expect(db.prepare("SELECT name FROM users WHERE id = ?").pluck(2)).toBe("bob");
    expect(db.prepare("SELECT name FROM users WHERE id = ?").pluck(404)).toBeUndefined();
  });

  it("accepts params as a single array or as positional args", () => {
    const insert = db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)");
    insert.run([1, "ann", true]); // array form
    insert.run(2, "bob", false); // spread form

    expect(db.prepare("SELECT id FROM users ORDER BY id").all()).toEqual([{ id: 1n }, { id: 2n }]);
  });

  it("coerces an integer JS number to bigint but rejects a non-integer", () => {
    db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(7, "n", true);
    expect(db.prepare("SELECT id FROM users WHERE id = ?").pluck(7)).toBe(7n);

    expect(() =>
      db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(1.5, "n", true),
    ).toThrow(BindError);
  });

  it("throws BindError when the parameter count does not match", () => {
    const insert = db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)");
    expect(() => insert.run(1, "ann")).toThrow(BindError); // too few
    expect(() => insert.run(1, "ann", true, 9)).toThrow(BindError); // too many
    expect(insert.parameterCount).toBe(3);
  });

  it("exposes one-shot query() and run() helpers on the database", () => {
    db.run("INSERT INTO users (id, name, active) VALUES (?, ?, ?)", [1, "ann", true]);
    db.run("INSERT INTO users (id, name, active) VALUES (?, ?, ?)", [2, "bob", false]);

    expect(db.query("SELECT name FROM users WHERE active = ?", [true])).toEqual([{ name: "ann" }]);
  });

  it("rejects all()/get() on a non-query statement", () => {
    expect(() =>
      db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").all(1, "a", true),
    ).toThrow(/not a query/);
  });

  it("flows a bound literal into index selection (EXPLAIN still picks IndexScan)", () => {
    db.exec("CREATE INDEX ON users (id)");
    const insert = db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)");
    for (let i = 1; i <= 50; i++) insert.run(i, `u${i}`, true);

    expect(db.prepare("SELECT name FROM users WHERE id = ?").get(42)).toEqual({ name: "u42" });
    const plan = db.exec("EXPLAIN SELECT * FROM users WHERE id = 42");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });

  it("errors clearly when exec() is given a statement with unbound placeholders", () => {
    expect(() => db.exec("SELECT * FROM users WHERE id = ?")).toThrow(BindError);
  });
});
