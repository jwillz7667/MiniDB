import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../db.js";

/**
 * Throughput + latency benchmarks. Numbers are illustrative of the engine's
 * shape (no external storage libraries), not a competition with production
 * databases. Run with `pnpm bench [rows] [queries]`.
 */

const ROWS = Number(process.argv[2] ?? 50_000);
const QUERIES = Number(process.argv[3] ?? 20_000);

function ms(fromNs: bigint): number {
  return Number(process.hrtime.bigint() - fromNs) / 1e6;
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx]!;
}

function withTempDb<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "minidb-bench-"));
  try {
    return fn(join(dir, "bench.minidb"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function row(line: string): void {
  process.stdout.write(`${line}\n`);
}

function main(): void {
  row(`minidb benchmark — ${ROWS} rows, ${QUERIES} point queries`);
  row("=".repeat(60));

  withTempDb((path) => {
    const db = Database.open(path, { poolSize: 1024 });
    db.exec("CREATE TABLE bench (id INT NOT NULL, val INT NOT NULL, label TEXT)");

    // --- Bulk insert (one transaction, so durability cost is amortized) ---
    let t = process.hrtime.bigint();
    db.exec("BEGIN");
    for (let i = 0; i < ROWS; i++) {
      db.exec(`INSERT INTO bench (id, val, label) VALUES (${i}, ${(i * 2654435761) % ROWS}, 'r${i}')`);
    }
    db.exec("COMMIT");
    const insertMs = ms(t);
    row(`insert            ${fmt(ROWS / (insertMs / 1000))} rows/sec  (${insertMs.toFixed(0)} ms total)`);

    // --- Build a secondary index ---
    t = process.hrtime.bigint();
    db.exec("CREATE INDEX ON bench (val)");
    row(`create index      ${ms(t).toFixed(0)} ms over ${ROWS} rows`);

    // --- Point queries through the index ---
    const samples: number[] = [];
    for (let q = 0; q < QUERIES; q++) {
      const key = (q * 7919) % ROWS;
      const start = process.hrtime.bigint();
      db.exec(`SELECT id FROM bench WHERE val = ${key}`);
      samples.push(ms(start));
    }
    samples.sort((a, b) => a - b);
    row(
      `point query       p50 ${percentile(samples, 50).toFixed(3)} ms  ` +
        `p99 ${percentile(samples, 99).toFixed(3)} ms  ` +
        `(${fmt(QUERIES / (samples.reduce((a, b) => a + b, 0) / 1000))} q/sec)`,
    );

    // --- Range scan throughput ---
    t = process.hrtime.bigint();
    const span = Math.floor(ROWS / 4);
    const res = db.exec(`SELECT id FROM bench WHERE id >= 0 AND id < ${span} ORDER BY id`);
    const scanned = res.type === "select" ? res.rows.length : 0;
    const scanMs = ms(t);
    row(`range scan        ${fmt(scanned / (scanMs / 1000))} rows/sec  (${scanned} rows, ${scanMs.toFixed(0)} ms)`);

    // --- Buffer pool hit rate over a hot working set ---
    for (let q = 0; q < QUERIES; q++) db.exec(`SELECT id FROM bench WHERE val = ${q % 64}`);
    row(`buffer pool       ${(db.hitRate() * 100).toFixed(1)}% hit rate`);

    db.close();
  });

  benchRecovery();
}

/** Build a multi-MB WAL of committed work, crash, and time the recovery. */
function benchRecovery(): void {
  withTempDb((path) => {
    const recoveryRows = Math.min(ROWS, 30_000);
    const db = Database.open(path, { poolSize: 256 });
    db.exec("CREATE TABLE r (id INT NOT NULL, val INT NOT NULL)");
    // Many committed transactions, no checkpoint -> the WAL keeps the redo work.
    for (let i = 0; i < recoveryRows; i += 500) {
      db.exec("BEGIN");
      for (let j = i; j < Math.min(i + 500, recoveryRows); j++) {
        db.exec(`INSERT INTO r (id, val) VALUES (${j}, ${j})`);
      }
      db.exec("COMMIT");
    }
    const walMb = statSync(`${path}-wal`).size / (1024 * 1024);
    // "Crash": abandon db without closing, then reopen to recover.
    rmSync(`${path}-lock`, { force: true }); // the crashed process's lock is now stale

    const start = process.hrtime.bigint();
    const recovered = Database.open(path, { poolSize: 256 });
    const recoverMs = ms(start);
    const stats = recovered.recoveryStats();
    const count = recovered.exec("SELECT id FROM r");
    const rows = count.type === "select" ? count.rows.length : 0;
    recovered.close();

    row(
      `recovery          ${recoverMs.toFixed(0)} ms for ${walMb.toFixed(1)} MB WAL ` +
        `(redone ${stats.redone}, ${rows} rows restored)`,
    );
  });
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

main();
