import type { ExecResult } from "./db.js";
import { ExecutionError } from "./errors.js";
import type { Value } from "./record/schema.js";
import type { Statement } from "./sql/ast.js";
import { bindStatement, type BindValue } from "./sql/bind.js";

/** A result row keyed by column name (last column wins on a name collision). */
export type Row = Record<string, Value>;

/** Summary of a mutating statement, in the style of better-sqlite3's `run()`. */
export interface RunResult {
  /** Rows inserted, updated, or deleted. */
  readonly changes: number;
  /** Internal rowid of the last inserted row, or null. */
  readonly lastInsertRowid: bigint | null;
}

/** A bind argument: a single value, or (as the sole argument) an array of values. */
type BindArg = BindValue | readonly BindValue[];

/** Accept both `stmt.all(1, 2)` and `stmt.all([1, 2])`. */
function flatten(args: readonly BindArg[]): BindValue[] {
  if (args.length === 1 && Array.isArray(args[0])) return [...(args[0] as readonly BindValue[])];
  return args as BindValue[];
}

/**
 * A reusable prepared statement: parsed once, then bound and executed many times
 * with different parameter values. Mirrors the ergonomics of better-sqlite3 —
 * `all`/`get`/`values`/`pluck` for queries, `run` for everything else — so the
 * `?`-placeholder API is the safe, natural way to pass user input (no string
 * concatenation, no injection surface).
 */
export class PreparedStatement {
  constructor(
    readonly sql: string,
    private readonly ast: Statement,
    private readonly paramCount: number,
    private readonly execute: (stmt: Statement) => ExecResult,
  ) {}

  /** Number of `?` placeholders this statement expects. */
  get parameterCount(): number {
    return this.paramCount;
  }

  private exec(args: readonly BindArg[]): ExecResult {
    return this.execute(bindStatement(this.ast, flatten(args), this.paramCount));
  }

  private select(args: readonly BindArg[]): {
    columns: string[];
    rows: Value[][];
  } {
    const result = this.exec(args);
    if (result.type !== "select") {
      throw new ExecutionError(`statement is not a query (it is ${result.type}); use run()`);
    }
    return { columns: result.columns, rows: result.rows };
  }

  /** Run a query and return every row as an object keyed by column name. */
  all(...params: BindArg[]): Row[] {
    const { columns, rows } = this.select(params);
    return rows.map((row) => toObject(columns, row));
  }

  /** Run a query and return the first row as an object, or undefined if empty. */
  get(...params: BindArg[]): Row | undefined {
    const { columns, rows } = this.select(params);
    const first = rows[0];
    return first ? toObject(columns, first) : undefined;
  }

  /** Run a query and return rows as positional arrays (no per-row object cost). */
  values(...params: BindArg[]): Value[][] {
    return this.select(params).rows;
  }

  /** Run a query and return the first column of the first row (handy for counts). */
  pluck(...params: BindArg[]): Value | undefined {
    const first = this.select(params).rows[0];
    return first ? first[0] : undefined;
  }

  /** Execute any statement and report rows changed + last inserted rowid. */
  run(...params: BindArg[]): RunResult {
    const result = this.exec(params);
    switch (result.type) {
      case "insert":
        return { changes: result.rowCount, lastInsertRowid: result.lastInsertRowid };
      case "delete":
        return { changes: result.rowCount, lastInsertRowid: null };
      default:
        return { changes: 0, lastInsertRowid: null };
    }
  }
}

function toObject(columns: string[], row: Value[]): Row {
  const out: Row = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]!] = row[i]!;
  return out;
}
