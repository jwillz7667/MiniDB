import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../../src/db.js";
import { CrashSim } from "../helpers/crash-sim.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

/** Deterministic PRNG so any failure reproduces from its seed. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** A reference model of the COMMITTED state: id -> v. */
class Oracle {
  readonly rows = new Map<number, number>();

  sorted(): bigint[][] {
    return [...this.rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, v]) => [BigInt(id), BigInt(v)]);
  }

  idsForV(v: number): bigint[] {
    return [...this.rows.entries()]
      .filter(([, vv]) => vv === v)
      .map(([id]) => BigInt(id))
      .sort((a, b) => Number(a - b));
  }
}

const V_RANGE = 20; // small, so many rows share a v (exercises non-unique index)

describe("crash-injection fuzzer", () => {
  let tmp: TempDb;
  const reopen = (): Database => {
    rmSync(`${tmp.path}-lock`, { force: true }); // the crashed process's lock is stale
    return Database.open(tmp.path);
  };
  const select = (db: Database, sql: string): bigint[][] => {
    const r = db.exec(sql);
    if (r.type !== "select") throw new Error("expected select");
    return r.rows as bigint[][];
  };

  beforeEach(() => {
    tmp = makeTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** Verify the database exactly matches the committed oracle, indexes included. */
  function verify(db: Database, oracle: Oracle): void {
    expect(select(db, "SELECT id, v FROM t ORDER BY id")).toEqual(oracle.sorted());
    for (let v = 0; v < V_RANGE; v++) {
      const viaIndex = select(db, `SELECT id FROM t WHERE v = ${v} ORDER BY id`).map((r) => r[0]!);
      expect(viaIndex).toEqual(oracle.idsForV(v));
    }
  }

  /** Apply one random committed/aborted operation, keeping the oracle in step. */
  function step(db: Database, oracle: Oracle, rng: () => number, nextId: { v: number }): void {
    const choice = rng();
    if (choice < 0.45) {
      const id = nextId.v++;
      const v = Math.floor(rng() * V_RANGE);
      db.exec(`INSERT INTO t (id, v) VALUES (${id}, ${v})`);
      oracle.rows.set(id, v);
    } else if (choice < 0.6 && oracle.rows.size > 0) {
      // In-place UPDATE of an indexed column: re-points the secondary index.
      const ids = [...oracle.rows.keys()];
      const id = ids[Math.floor(rng() * ids.length)]!;
      const v = Math.floor(rng() * V_RANGE);
      db.prepare("UPDATE t SET v = ? WHERE id = ?").run(v, id);
      oracle.rows.set(id, v);
    } else if (choice < 0.72 && oracle.rows.size > 0) {
      const ids = [...oracle.rows.keys()];
      const id = ids[Math.floor(rng() * ids.length)]!;
      db.exec(`DELETE FROM t WHERE id = ${id}`);
      oracle.rows.delete(id);
    } else {
      db.exec("BEGIN");
      const pending: Array<[number, number]> = [];
      const n = 1 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const id = nextId.v++;
        const v = Math.floor(rng() * V_RANGE);
        db.exec(`INSERT INTO t (id, v) VALUES (${id}, ${v})`);
        pending.push([id, v]);
      }
      if (rng() < 0.6) {
        db.exec("COMMIT");
        for (const [id, v] of pending) oracle.rows.set(id, v);
      } else {
        db.exec("ROLLBACK");
      }
    }
  }

  it("loses no committed rows under repeated simulated power-loss crashes", () => {
    const TRIALS = 15;
    const CYCLES = 3;
    const BATCH = 8;

    for (let trial = 0; trial < TRIALS; trial++) {
      const rng = makeRng(0x5eed + trial * 1009);
      const oracle = new Oracle();
      const nextId = { v: 0 };

      // Faithful power loss: only fsync'd bytes survive a crash.
      const sim = new CrashSim([tmp.path, `${tmp.path}-wal`]);
      sim.arm();

      let db = Database.open(tmp.path);
      db.exec("CREATE TABLE t (id INT NOT NULL, v INT NOT NULL)");
      db.exec("CREATE INDEX ON t (v)");

      for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (let i = 0; i < BATCH; i++) step(db, oracle, rng, nextId);
        // Crash: drop everything not fsync'd, then recover and verify.
        sim.crash();
        db = reopen();
        verify(db, oracle);
      }

      sim.disarm();
      db.close();
      rmSync(tmp.path, { force: true });
      rmSync(`${tmp.path}-wal`, { force: true });
      rmSync(`${tmp.path}-lock`, { force: true });
    }
  });

  it("the crash model has teeth: with fsync off, a crash loses committed data", () => {
    // Proves the simulator actually drops un-fsync'd writes — in "off" mode the
    // engine never fsyncs, so a power loss reverts the files to empty.
    const sim = new CrashSim([tmp.path, `${tmp.path}-wal`]);
    sim.arm();

    const db = Database.open(tmp.path, { synchronous: "off" });
    db.exec("CREATE TABLE t (id INT NOT NULL, v INT NOT NULL)");
    db.exec("INSERT INTO t (id, v) VALUES (1, 1), (2, 2)");
    expect(select(db, "SELECT id FROM t ORDER BY id")).toEqual([[1n], [2n]]);

    sim.crash();
    sim.disarm();
    const db2 = reopen(); // opens in default "full" mode on the reverted (empty) files
    // The table never became durable, so it is gone after the power loss.
    expect(() => db2.exec("SELECT id FROM t")).toThrow();
    db2.close();
  });
});
