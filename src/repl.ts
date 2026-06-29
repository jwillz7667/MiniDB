import { createInterface } from "node:readline";

import { Database, type ExecResult } from "./db.js";
import { MiniDBError } from "./errors.js";
import type { Value } from "./record/schema.js";
import { valueToDisplay } from "./record/value.js";

/**
 * Interactive SQL shell. Statements may span multiple lines and end with `;`.
 * Lines beginning with `.` are meta-commands (`.help`, `.tables`, `.schema`,
 * `.checkpoint`, `.exit`).
 */
function main(): void {
  const path = process.argv[2] ?? "minidb.minidb";
  const db = Database.open(path);
  const r = db.recoveryStats();
  process.stdout.write(`minidb — ${path}\n`);
  if (r.records > 0) {
    process.stdout.write(
      `recovered from WAL: redone ${r.redone}, undone ${r.undone}, committed ${r.committed}\n`,
    );
  }
  process.stdout.write('Type SQL ending with ";", or .help for commands.\n\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "minidb> " });
  let buffer = "";

  const finish = (): void => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  };

  rl.prompt();
  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (buffer === "" && trimmed.startsWith(".")) {
      if (handleMeta(db, trimmed)) {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    buffer += `${line}\n`;
    if (!buffer.trimEnd().endsWith(";")) {
      rl.setPrompt("    ..> ");
      rl.prompt();
      return;
    }

    const sql = buffer.trim();
    buffer = "";
    rl.setPrompt("minidb> ");
    runSql(db, sql);
    rl.prompt();
  });

  rl.on("close", finish);
}

function handleMeta(db: Database, command: string): boolean {
  const [name, arg] = command.slice(1).split(/\s+/, 2);
  switch (name) {
    case "exit":
    case "quit":
      return true;
    case "help":
      process.stdout.write(
        [
          "  .tables            list user tables",
          "  .schema <table>    show a table's columns",
          "  .checkpoint        flush dirty pages and write a checkpoint",
          "  .stats             buffer-pool hit rate",
          "  .exit              quit",
          "  EXPLAIN <select>   show the chosen operator tree",
          "",
        ].join("\n"),
      );
      return false;
    case "tables":
      process.stdout.write(`${db.tableNames().join("\n") || "(none)"}\n`);
      return false;
    case "schema": {
      const meta = arg ? db.tableMeta(arg) : undefined;
      if (!meta) process.stdout.write(`no such table: ${arg ?? ""}\n`);
      else {
        for (const c of meta.columns) {
          process.stdout.write(`  ${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}\n`);
        }
      }
      return false;
    }
    case "checkpoint":
      db.checkpoint();
      process.stdout.write("checkpoint written\n");
      return false;
    case "stats":
      process.stdout.write(`buffer-pool hit rate: ${(db.hitRate() * 100).toFixed(1)}%\n`);
      return false;
    default:
      process.stdout.write(`unknown command: .${name ?? ""} (try .help)\n`);
      return false;
  }
}

function runSql(db: Database, sql: string): void {
  const started = process.hrtime.bigint();
  let result: ExecResult;
  try {
    result = db.exec(sql);
  } catch (err) {
    const message = err instanceof MiniDBError ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  printResult(result);
  process.stdout.write(`(${ms.toFixed(2)} ms)\n\n`);
}

function printResult(result: ExecResult): void {
  switch (result.type) {
    case "select":
      printTable(result.columns, result.rows);
      process.stdout.write(`${result.rows.length} row${result.rows.length === 1 ? "" : "s"}\n`);
      return;
    case "insert":
      process.stdout.write(`inserted ${result.rowCount}\n`);
      return;
    case "update":
      process.stdout.write(`updated ${result.rowCount}\n`);
      return;
    case "delete":
      process.stdout.write(`deleted ${result.rowCount}\n`);
      return;
    case "createTable":
      process.stdout.write(`created table ${result.table}\n`);
      return;
    case "createIndex":
      process.stdout.write(`created index on ${result.table}(${result.column})\n`);
      return;
    case "dropTable":
      process.stdout.write(`dropped table ${result.table}\n`);
      return;
    case "dropIndex":
      process.stdout.write(`dropped index on ${result.table}(${result.column})\n`);
      return;
    case "alterTable":
      process.stdout.write(`added column ${result.table}.${result.column}\n`);
      return;
    case "explain":
      process.stdout.write(`${result.lines.join("\n")}\n`);
      return;
    case "begin":
    case "commit":
    case "rollback":
      process.stdout.write(`${result.type}\n`);
      return;
    case "vacuum":
      process.stdout.write(`vacuum: ${result.pagesBefore} -> ${result.pagesAfter} pages\n`);
      return;
  }
}

function printTable(columns: string[], rows: Value[][]): void {
  const cells = rows.map((row) => row.map(valueToDisplay));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => (row[i] ?? "").length), 0),
  );
  const line = (parts: string[]): string =>
    `| ${parts.map((p, i) => p.padEnd(widths[i]!)).join(" | ")} |\n`;
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+\n`;

  process.stdout.write(sep);
  process.stdout.write(line(columns));
  process.stdout.write(sep);
  for (const row of cells) process.stdout.write(line(row));
  process.stdout.write(sep);
}

main();
