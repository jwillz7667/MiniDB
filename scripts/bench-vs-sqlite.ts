/**
 * Rough head-to-head against better-sqlite3, if it happens to be installed.
 * minidb does NOT depend on it; this script dynamically imports it and skips the
 * comparison when it is absent. Both run in-memory to compare CPU, not fsync.
 *
 *   pnpm bench:vs-sqlite
 *   pnpm add -D better-sqlite3   # to enable the comparison
 */
import { Database } from "../src/index.js";

const N = 50_000;

function time(label: string, fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  process.stdout.write(`  ${label.padEnd(28)} ${ms.toFixed(1).padStart(8)} ms\n`);
  return ms;
}

function benchMinidb(): void {
  const db = Database.open(":memory:");
  db.exec("CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL)");
  const insert = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
  time(`insert ${N} (1 txn)`, () => {
    db.exec("BEGIN");
    for (let i = 0; i < N; i++) insert.run(i, i % 1000);
    db.exec("COMMIT");
  });
  const get = db.prepare("SELECT v FROM t WHERE id = ?");
  time(`${N} point lookups (PK)`, () => {
    for (let i = 0; i < N; i++) get.pluck(i);
  });
  db.close();
}

async function benchSqlite(): Promise<boolean> {
  let BetterSqlite3: new (path: string) => SqliteLike;
  try {
    const name = "better-sqlite3"; // non-literal specifier so this typechecks without it
    BetterSqlite3 = ((await import(name)) as { default: new (path: string) => SqliteLike }).default;
  } catch {
    return false;
  }
  const db = new BetterSqlite3(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (let i = 0; i < N; i++) insert.run(i, i % 1000);
  });
  time(`insert ${N} (1 txn)`, () => tx());
  const get = db.prepare("SELECT v FROM t WHERE id = ?");
  time(`${N} point lookups (PK)`, () => {
    for (let i = 0; i < N; i++) get.get(i);
  });
  db.close();
  return true;
}

interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...a: number[]): unknown; get(...a: number[]): unknown };
  transaction(fn: () => void): () => void;
  close(): void;
}

async function main(): Promise<void> {
  process.stdout.write("minidb (in-memory):\n");
  benchMinidb();
  process.stdout.write("\nbetter-sqlite3 (in-memory):\n");
  if (!(await benchSqlite())) {
    process.stdout.write("  not installed — run `pnpm add -D better-sqlite3` to compare\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
