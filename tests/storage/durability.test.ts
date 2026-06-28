import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../../src/db.js";
import { Durability, setSyncFault, type SyncMode } from "../../src/storage/durability.js";
import { Pager } from "../../src/storage/pager.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

describe("durability modes", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = makeTempDb();
  });

  afterEach(() => {
    setSyncFault(null);
    tmp.cleanup();
  });

  for (const mode of ["full", "normal", "off"] as SyncMode[]) {
    it(`round-trips data and survives a clean reopen in "${mode}" mode`, () => {
      let db = Database.open(tmp.path, { synchronous: mode });
      db.exec("CREATE TABLE t (id INT NOT NULL, n INT NOT NULL)");
      db.exec("INSERT INTO t (id, n) VALUES (1, 10), (2, 20)");
      db.close();

      db = Database.open(tmp.path, { synchronous: mode });
      const r = db.exec("SELECT id FROM t ORDER BY id");
      expect(r.type === "select" && r.rows).toEqual([[1n], [2n]]);
      db.close();
    });
  }

  it("the fault hook fires at a durability barrier (crash-injection seam)", () => {
    const pager = Pager.open(tmp.path, new Durability("full"));
    const pageNo = pager.allocatePage();
    setSyncFault(() => {
      throw new Error("simulated crash");
    });
    expect(() => pager.writePage(pageNo, Buffer.alloc(4096), true)).toThrow("simulated crash");
    setSyncFault(null);
    pager.close();
  });

  it('"off" performs no fsync barriers; "full" does', () => {
    let hookCalls = 0;
    setSyncFault(() => {
      hookCalls += 1;
    });

    const off = new Durability("off");
    off.barrier(-1, "x");
    off.commitBarrier(-1, "x");
    expect(hookCalls).toBe(0); // no real fsync attempted, so the hook never runs

    // 'full' runs the hook, then fsync(-1) fails with EBADF — we only assert the hook ran.
    expect(() => new Durability("full").barrier(-1, "x")).toThrow();
    expect(hookCalls).toBe(1);
  });
});
