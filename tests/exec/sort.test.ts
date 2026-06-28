import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../../src/db.js";
import { ExecutionError } from "../../src/errors.js";
import { makeEngine, type TestEngine } from "../helpers/engine.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

describe("bounded sort", () => {
  describe("top-N correctness via makeEngine", () => {
    let db: TestEngine;

    beforeEach(() => {
      db = makeEngine();
      db.exec("CREATE TABLE t (id INT NOT NULL, k INT NOT NULL)");
      // Insert in scrambled order.
      for (let i = 0; i < 500; i++) {
        const k = (i * 2654435761) % 1000;
        db.exec(`INSERT INTO t (id, k) VALUES (${i}, ${k})`);
      }
    });

    afterEach(() => db.cleanup());

    it("ORDER BY ... LIMIT n returns the same rows as a full sort", () => {
      const full = db.query("SELECT k FROM t ORDER BY k ASC").map((r) => r[0]);
      const topN = db.query("SELECT k FROM t ORDER BY k ASC LIMIT 7").map((r) => r[0]);
      expect(topN).toEqual(full.slice(0, 7));

      const fullDesc = db.query("SELECT k FROM t ORDER BY k DESC").map((r) => r[0]);
      const topDesc = db.query("SELECT k FROM t ORDER BY k DESC LIMIT 5").map((r) => r[0]);
      expect(topDesc).toEqual(fullDesc.slice(0, 5));
    });

    it("EXPLAIN annotates the bounded sort", () => {
      const r = db.exec("EXPLAIN SELECT id FROM t ORDER BY k DESC LIMIT 10");
      const lines = r.type === "explain" ? r.lines.join("\n") : "";
      expect(lines).toContain("Sort k DESC (top 10)");
    });
  });

  describe("fail-safe cap on unbounded sorts", () => {
    let tmp: TempDb;

    beforeEach(() => {
      tmp = makeTempDb();
    });

    afterEach(() => tmp.cleanup());

    it("throws instead of buffering an unbounded ORDER BY past the cap", () => {
      const db = Database.open(tmp.path, { maxSortRows: 5 });
      db.exec("CREATE TABLE t (id INT NOT NULL)");
      for (let i = 0; i < 20; i++) db.exec(`INSERT INTO t (id) VALUES (${i})`);

      expect(() => db.exec("SELECT id FROM t ORDER BY id")).toThrow(ExecutionError);
      // A bounded top-N within the cap still works.
      const r = db.exec("SELECT id FROM t ORDER BY id LIMIT 3");
      expect(r.type === "select" && r.rows).toEqual([[0n], [1n], [2n]]);
      db.close();
    });
  });
});
