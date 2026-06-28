import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../../src/db.js";
import { setSyncFault } from "../../src/storage/durability.js";
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
    setSyncFault(null);
    tmp.cleanup();
  });

  /** Verify the database exactly matches the committed oracle, indexes included. */
  function verify(db: Database, oracle: Oracle): void {
    expect(select(db, "SELECT id, v FROM t ORDER BY id")).toEqual(oracle.sorted());
    // The secondary index on v must agree with the heap for every value.
    for (let v = 0; v < V_RANGE; v++) {
      const viaIndex = select(db, `SELECT id FROM t WHERE v = ${v} ORDER BY id`).map((r) => r[0]!);
      expect(viaIndex).toEqual(oracle.idsForV(v));
    }
  }

  /** Apply one random committed/aborted operation, keeping the oracle in step. */
  function step(db: Database, oracle: Oracle, rng: () => number, nextId: { v: number }): void {
    const choice = rng();
    if (choice < 0.5) {
      const id = nextId.v++;
      const v = Math.floor(rng() * V_RANGE);
      db.exec(`INSERT INTO t (id, v) VALUES (${id}, ${v})`);
      oracle.rows.set(id, v);
    } else if (choice < 0.7 && oracle.rows.size > 0) {
      const ids = [...oracle.rows.keys()];
      const id = ids[Math.floor(rng() * ids.length)]!;
      db.exec(`DELETE FROM t WHERE id = ${id}`);
      oracle.rows.delete(id);
    } else {
      // An explicit transaction that either commits or rolls back.
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

  it("survives repeated crashes with no lost-committed / surviving-uncommitted rows", () => {
    const TRIALS = 20;
    const CYCLES = 3;
    const BATCH = 10;

    for (let trial = 0; trial < TRIALS; trial++) {
      const rng = makeRng(0x5eed + trial * 1009);
      const oracle = new Oracle();
      const nextId = { v: 0 };

      let db = Database.open(tmp.path);
      db.exec("CREATE TABLE t (id INT NOT NULL, v INT NOT NULL)");
      db.exec("CREATE INDEX ON t (v)");

      for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (let i = 0; i < BATCH; i++) step(db, oracle, rng, nextId);
        // "Crash": abandon without closing, then recover and verify.
        db = reopen();
        verify(db, oracle);
      }
      db.close();
      rmSync(tmp.path, { force: true });
      rmSync(`${tmp.path}-wal`, { force: true });
      rmSync(`${tmp.path}-lock`, { force: true });
    }
  });

  it("stays internally consistent when crashed mid-commit at an fsync", () => {
    // Build some durable state first.
    let db = Database.open(tmp.path);
    db.exec("CREATE TABLE t (id INT NOT NULL, v INT NOT NULL)");
    db.exec("CREATE INDEX ON t (v)");
    db.exec("BEGIN");
    for (let i = 0; i < 50; i++) db.exec(`INSERT INTO t (id, v) VALUES (${i}, ${i % V_RANGE})`);
    db.exec("COMMIT");

    // Arm a crash on the next fsync, then drive writes until it fires.
    let crashed = false;
    setSyncFault(() => {
      throw new Error("SIMULATED_CRASH");
    });
    try {
      for (let i = 50; i < 200; i++) db.exec(`INSERT INTO t (id, v) VALUES (${i}, ${i % V_RANGE})`);
    } catch (err) {
      crashed = (err as Error).message === "SIMULATED_CRASH";
    }
    setSyncFault(null);
    expect(crashed).toBe(true);

    // Recover and assert internal consistency: the index agrees with the heap,
    // and every page reads back (checksums pass).
    db = reopen();
    const all = select(db, "SELECT id, v FROM t ORDER BY id");
    for (let v = 0; v < V_RANGE; v++) {
      const viaIndex = select(db, `SELECT id FROM t WHERE v = ${v} ORDER BY id`).map((r) => r[0]!);
      const viaScan = all
        .filter((row) => row[1] === BigInt(v))
        .map((row) => row[0]!)
        .sort((a, b) => Number(a - b));
      expect(viaIndex).toEqual(viaScan);
    }
    db.close();
  });
});
