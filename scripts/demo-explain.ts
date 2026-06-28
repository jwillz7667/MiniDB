import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../src/db.js";

/**
 * Phase 5 demo: the optimizer choosing an IndexScan over a SeqScan once an index
 * exists, while both return identical results.
 */
const dir = mkdtempSync(join(tmpdir(), "minidb-demo-explain-"));
const path = join(dir, "explain.minidb");

function explain(db: Database, sql: string): string {
  const r = db.exec(`EXPLAIN ${sql}`);
  return r.type === "explain" ? r.lines.join("\n") : "";
}

function rowsFor(db: Database, sql: string): string {
  const r = db.exec(sql);
  return r.type === "select" ? r.rows.map((row) => row.join(",")).join(" | ") : "";
}

try {
  const out = process.stdout;
  const db = Database.open(path);
  db.exec("CREATE TABLE people (id INT NOT NULL, age INT NOT NULL, city TEXT)");
  db.exec("BEGIN");
  for (let i = 0; i < 1000; i++) {
    db.exec(`INSERT INTO people (id, age, city) VALUES (${i}, ${18 + (i % 60)}, 'city${i % 10}')`);
  }
  db.exec("COMMIT");

  const query = "SELECT id FROM people WHERE age = 40 AND city = 'city2'";

  out.write("minidb optimizer demo\n\n");
  out.write(`query: ${query}\n\n`);

  out.write("Without an index — full scan:\n");
  out.write(`${indent(explain(db, query))}\n\n`);
  const before = rowsFor(db, `${query} ORDER BY id`);

  db.exec("CREATE INDEX ON people (age)");

  out.write("After CREATE INDEX ON people (age) — the optimizer pushes age=40\n");
  out.write("into an index scan and keeps city='city2' as a residual filter:\n");
  out.write(`${indent(explain(db, query))}\n\n`);
  const after = rowsFor(db, `${query} ORDER BY id`);

  out.write(`Same results either way: ${before === after ? "yes" : "NO"}\n`);
  out.write(`matching ids: ${after || "(none)"}\n`);
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
