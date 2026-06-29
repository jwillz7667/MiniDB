import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../src/db.js";
import { PlanError } from "../src/errors.js";
import { makeTempDb, type TempDb } from "./helpers/tmp.js";

describe("aggregates, GROUP BY, HAVING", () => {
  let tmp: TempDb;
  let db: Database;

  beforeEach(() => {
    tmp = makeTempDb();
    db = Database.open(tmp.path);
    db.exec(
      "CREATE TABLE sales (id INT PRIMARY KEY, region TEXT NOT NULL, amount INT, price REAL)",
    );
    const s = db.prepare("INSERT INTO sales (id, region, amount, price) VALUES (?, ?, ?, ?)");
    s.run(1, "east", 100, 1.5);
    s.run(2, "east", 200, 2.5);
    s.run(3, "west", 50, 0.5);
    s.run(4, "west", null, 4.0); // amount NULL
    s.run(5, "east", 300, null); // price NULL
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("computes whole-table aggregates with correct NULL handling", () => {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, COUNT(amount) AS na, SUM(amount) AS s, AVG(amount) AS a, " +
          "MIN(amount) AS mn, MAX(amount) AS mx FROM sales",
      )
      .get();
    expect(row).toEqual({ n: 5n, na: 4n, s: 650n, a: 162.5, mn: 50n, mx: 300n });
  });

  it("aggregates REAL columns to a REAL result", () => {
    const row = db.prepare("SELECT SUM(price) AS s, AVG(price) AS a FROM sales").get();
    expect(row).toEqual({ s: 8.5, a: 2.125 });
  });

  it("groups by a column", () => {
    const rows = db
      .prepare("SELECT region, COUNT(*) AS n, SUM(amount) AS total FROM sales GROUP BY region")
      .all();
    expect(rows).toEqual([
      { region: "east", n: 3n, total: 600n },
      { region: "west", n: 2n, total: 50n }, // west has one NULL amount
    ]);
  });

  it("filters groups with HAVING (by alias and by bare aggregate)", () => {
    expect(
      db.prepare("SELECT region, COUNT(*) AS n FROM sales GROUP BY region HAVING n > 2").all(),
    ).toEqual([{ region: "east", n: 3n }]);

    expect(
      db
        .prepare("SELECT region FROM sales GROUP BY region HAVING COUNT(*) > 2")
        .all(),
    ).toEqual([{ region: "east" }]);
  });

  it("orders and limits grouped output by an aggregate alias", () => {
    const rows = db
      .prepare("SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total")
      .values();
    expect(rows).toEqual([
      ["west", 50n],
      ["east", 600n],
    ]);
  });

  it("returns one row for a whole-table aggregate over an empty table", () => {
    db.exec("DELETE FROM sales");
    const row = db
      .prepare("SELECT COUNT(*) AS n, SUM(amount) AS s, AVG(amount) AS a, MAX(amount) AS mx FROM sales")
      .get();
    expect(row).toEqual({ n: 0n, s: null, a: null, mx: null });
  });

  it("returns no rows for a GROUP BY over an empty table", () => {
    db.exec("DELETE FROM sales");
    expect(db.prepare("SELECT region, COUNT(*) FROM sales GROUP BY region").all()).toEqual([]);
  });

  it("combines aggregation with a JOIN", () => {
    db.exec("CREATE TABLE reps (id INT PRIMARY KEY, region TEXT NOT NULL, name TEXT NOT NULL)");
    const r = db.prepare("INSERT INTO reps (id, region, name) VALUES (?, ?, ?)");
    r.run(1, "east", "Eve");
    r.run(2, "west", "Walt");

    const rows = db
      .prepare(
        "SELECT r.name AS rep, SUM(s.amount) AS total FROM sales s " +
          "JOIN reps r ON s.region = r.region GROUP BY r.name ORDER BY total",
      )
      .all();
    expect(rows).toEqual([
      { rep: "Walt", total: 50n },
      { rep: "Eve", total: 600n },
    ]);
  });

  it("explains an aggregate plan", () => {
    const plan = db.exec("EXPLAIN SELECT region, COUNT(*) FROM sales GROUP BY region");
    expect(plan.type === "explain" && plan.lines.join("\n")).toContain("Aggregate");
  });

  it("rejects invalid aggregate queries", () => {
    expect(() => db.exec("SELECT region, amount FROM sales GROUP BY region")).toThrow(PlanError); // amount not grouped
    expect(() => db.exec("SELECT * FROM sales GROUP BY region")).toThrow(PlanError); // SELECT *
    expect(() => db.exec("SELECT SUM(region) FROM sales")).toThrow(PlanError); // sum of TEXT
  });
});
