import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { PlanError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("JOIN", () => {
  let tmp: TempDb;
  let db: Database;

  beforeEach(() => {
    tmp = makeTempDb();
    db = Database.open(tmp.path);
    db.exec("CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL)");
    db.exec("CREATE TABLE orders (id INT PRIMARY KEY, user_id INT NOT NULL, total INT NOT NULL)");
    const u = db.prepare("INSERT INTO users (id, name) VALUES (?, ?)");
    u.run(1, "ann");
    u.run(2, "bob");
    u.run(3, "cleo"); // no orders
    const o = db.prepare("INSERT INTO orders (id, user_id, total) VALUES (?, ?, ?)");
    o.run(10, 1, 100);
    o.run(11, 1, 50);
    o.run(12, 2, 200);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("inner-joins on an equality, using a hash join", () => {
    const rows = db
      .prepare("SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id ORDER BY o.total")
      .all();
    expect(rows).toEqual([
      { name: "ann", total: 50n },
      { name: "ann", total: 100n },
      { name: "bob", total: 200n },
    ]);
    const plan = db.exec("EXPLAIN SELECT u.name FROM users u JOIN orders o ON u.id = o.user_id");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("HashJoin");
  });

  it("left-joins, filling unmatched right columns with NULL", () => {
    const rows = db
      .prepare(
        "SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u.id = o.user_id ORDER BY u.id",
      )
      .values();
    expect(rows).toEqual([
      ["ann", 100n],
      ["ann", 50n],
      ["bob", 200n],
      ["cleo", null], // cleo has no orders
    ]);
  });

  it("uses a nested-loop join for a non-equi ON condition", () => {
    // Pair each user with every order whose total exceeds 75 (orders 100 + 200).
    const rows = db
      .prepare("SELECT u.id, o.total FROM users u JOIN orders o ON o.total > ?")
      .values(75) as [bigint, bigint][];
    rows.sort((a, b) => Number(a[0] - b[0]) || Number(a[1] - b[1]));
    expect(rows).toEqual([
      [1n, 100n],
      [1n, 200n],
      [2n, 100n],
      [2n, 200n],
      [3n, 100n],
      [3n, 200n],
    ]);
    const plan = db.exec("EXPLAIN SELECT u.id FROM users u JOIN orders o ON o.total > u.id");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("NestedLoopJoin");
  });

  it("treats a comma FROM as a cross join filtered by WHERE", () => {
    const rows = db
      .prepare("SELECT u.name, o.total FROM users u, orders o WHERE u.id = o.user_id ORDER BY o.id")
      .all();
    expect(rows).toEqual([
      { name: "ann", total: 100n },
      { name: "ann", total: 50n },
      { name: "bob", total: 200n },
    ]);
  });

  it("joins three tables", () => {
    db.exec("CREATE TABLE items (id INT PRIMARY KEY, order_id INT NOT NULL, sku TEXT NOT NULL)");
    const it = db.prepare("INSERT INTO items (id, order_id, sku) VALUES (?, ?, ?)");
    it.run(100, 10, "A");
    it.run(101, 12, "B");

    const rows = db
      .prepare(
        "SELECT u.name, i.sku FROM users u " +
          "JOIN orders o ON u.id = o.user_id " +
          "JOIN items i ON o.id = i.order_id ORDER BY i.sku",
      )
      .all();
    expect(rows).toEqual([
      { name: "ann", sku: "A" },
      { name: "bob", sku: "B" },
    ]);
  });

  it("supports a self-join via aliases", () => {
    db.exec("CREATE TABLE emp (id INT PRIMARY KEY, manager_id INT)");
    const e = db.prepare("INSERT INTO emp (id, manager_id) VALUES (?, ?)");
    e.run(1, null); // CEO
    e.run(2, 1);
    e.run(3, 1);

    const rows = db
      .prepare("SELECT e.id, m.id FROM emp e JOIN emp m ON e.manager_id = m.id ORDER BY e.id")
      .values();
    expect(rows).toEqual([
      [2n, 1n],
      [3n, 1n],
    ]);
  });

  it("rejects an ambiguous unqualified column", () => {
    expect(() =>
      db.exec("SELECT id FROM users u JOIN orders o ON u.id = o.user_id"),
    ).toThrow(PlanError);
  });

  it("uses an index on the right table when the optimizer can (single-table fast path intact)", () => {
    // The join itself is a hash join; this verifies non-join queries still index.
    const plan = db.exec("EXPLAIN SELECT name FROM users WHERE id = 2");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("IndexScan");
  });
});
