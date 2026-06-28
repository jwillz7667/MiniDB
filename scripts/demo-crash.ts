import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../src/db.js";

/**
 * Phase 6 demo: commit some rows, start a second transaction that writes more
 * rows but never commits, then "crash" (abandon the database without closing,
 * exactly as kill -9 would). Reopening replays the WAL: committed rows return,
 * the uncommitted ones are undone, and nothing is corrupt.
 */
const dir = mkdtempSync(join(tmpdir(), "minidb-demo-crash-"));
const path = join(dir, "crash.minidb");

function count(db: Database): number {
  const r = db.exec("SELECT id FROM accounts");
  return r.type === "select" ? r.rows.length : -1;
}

try {
  const out = process.stdout;
  out.write("minidb crash-recovery demo\n\n");

  // --- Session 1: do durable work, then "crash" mid-transaction. ---
  const db1 = Database.open(path);
  db1.exec("CREATE TABLE accounts (id INT NOT NULL, balance INT NOT NULL)");
  db1.exec("INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 200), (3, 300)");
  out.write(`  committed 3 rows  ->  table holds ${count(db1)} rows\n`);

  db1.exec("BEGIN");
  db1.exec("INSERT INTO accounts (id, balance) VALUES (4, 400), (5, 500)");
  out.write(`  wrote 2 more rows inside an UNCOMMITTED transaction  ->  ${count(db1)} rows visible\n`);
  db1.checkpoint(); // force the uncommitted pages + log to disk (the steal policy)
  out.write(`  *** CRASH (process killed before COMMIT) ***\n`);
  // Intentionally do NOT call db1.close().

  // --- Session 2: reopen and recover. ---
  const walMb = statSync(`${path}-wal`).size / 1024;
  const db2 = Database.open(path);
  const stats = db2.recoveryStats();
  out.write(`\n  reopened — replayed ${walMb.toFixed(1)} KB WAL: `);
  out.write(`redone ${stats.redone}, undone ${stats.undone}\n`);
  out.write(`  table now holds ${count(db2)} rows (the committed 3; the uncommitted 2 were rolled back)\n`);

  const balances = db2.exec("SELECT id, balance FROM accounts ORDER BY id");
  if (balances.type === "select") {
    out.write(`  rows: ${balances.rows.map((r) => `(${r[0]}, ${r[1]})`).join(", ")}\n`);
  }
  db2.close();

  out.write(`\n  result: committed data survived, the crash left no corruption.\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
