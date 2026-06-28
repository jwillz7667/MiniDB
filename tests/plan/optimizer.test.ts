import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeEngine, type TestEngine } from "../helpers/engine.js";

/** Return the EXPLAIN text for a SELECT. */
function plan(db: TestEngine, sql: string): string {
  const r = db.exec(`EXPLAIN ${sql}`);
  return r.type === "explain" ? r.lines.join("\n") : "";
}

describe("optimizer index selection", () => {
  let db: TestEngine;

  beforeEach(() => {
    db = makeEngine();
    db.exec("CREATE TABLE t (id INT NOT NULL, k INT NOT NULL, label TEXT)");
    db.exec("INSERT INTO t (id, k, label) VALUES (1, 10, 'a'), (2, 20, 'b'), (3, 20, 'c')");
    db.exec("CREATE INDEX ON t (k)");
  });

  afterEach(() => db.cleanup());

  it("selects an index when the literal is on the left (k normalized)", () => {
    expect(plan(db, "SELECT * FROM t WHERE 20 = k")).toContain("IndexScan t.k [20, 20]");
    expect(plan(db, "SELECT * FROM t WHERE 15 < k")).toContain("IndexScan t.k [16, +inf]");
  });

  it("does not use an index for != (not a contiguous range)", () => {
    const p = plan(db, "SELECT * FROM t WHERE k != 20");
    expect(p).toContain("SeqScan t");
    expect(p).toContain("Filter k != 20");
  });

  it("does not use an index for an unindexed column", () => {
    expect(plan(db, "SELECT * FROM t WHERE id = 1")).toContain("SeqScan t");
  });

  it("picks the indexed conjunct and keeps the rest as a residual filter", () => {
    const p = plan(db, "SELECT * FROM t WHERE label = 'b' AND k = 20");
    expect(p).toContain("IndexScan t.k [20, 20]");
    expect(p).toContain("Filter label = 'b'");
  });

  it("an index scan and a seq scan return identical rows", () => {
    const viaIndex = db.query("SELECT id FROM t WHERE k = 20 ORDER BY id");
    db.exec("CREATE TABLE u (id INT NOT NULL, k INT NOT NULL)");
    db.exec("INSERT INTO u (id, k) VALUES (1, 10), (2, 20), (3, 20)");
    const viaSeq = db.query("SELECT id FROM u WHERE k = 20 ORDER BY id");
    expect(viaIndex).toEqual(viaSeq);
    expect(viaIndex).toEqual([[2n], [3n]]);
  });
});
