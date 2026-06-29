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
    let syncCalls = 0;
    setSyncFault(() => {
      hookCalls += 1;
    });
    const file = {
      readAt: () => 0,
      writeAt: () => 0,
      truncate: () => {},
      size: () => 0,
      sync: () => {
        syncCalls += 1;
      },
      close: () => {},
    };

    const off = new Durability("off");
    off.barrier(file, "x");
    off.commitBarrier(file, "x");
    expect(hookCalls).toBe(0); // no barrier attempted, so neither the hook nor sync runs
    expect(syncCalls).toBe(0);

    new Durability("full").barrier(file, "x");
    expect(hookCalls).toBe(1); // the hook fires immediately before the real sync
    expect(syncCalls).toBe(1);
  });
});
