import { ExecutionError, TupleError } from "../errors.js";
import type { ColumnType, Value } from "./schema.js";

/** Human-readable name of a value's runtime type, for error messages. */
function describe(v: Value): string {
  if (v === null) return "NULL";
  if (v instanceof Date) return "DATETIME";
  if (v instanceof Uint8Array) return "BLOB";
  return typeof v; // bigint | number | string | boolean
}

const isNumeric = (v: Value): v is bigint | number =>
  typeof v === "bigint" || typeof v === "number";

/**
 * Coerce a non-null value to a column's canonical runtime representation,
 * applying numeric affinity (INT↔REAL, and integer/epoch inputs to DATETIME) so
 * the engine is usable with ordinary JS values while still rejecting genuinely
 * incompatible types. Throws `TupleError` on an incompatible value.
 */
export function coerceToColumnType(
  type: ColumnType,
  value: Exclude<Value, null>,
  columnName: string,
): Exclude<Value, null> {
  switch (type) {
    case "INT":
      if (typeof value === "bigint") return value;
      if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
      break;
    case "REAL":
      if (typeof value === "number") return value;
      if (typeof value === "bigint") return Number(value);
      break;
    case "TEXT":
      if (typeof value === "string") return value;
      break;
    case "BOOL":
      if (typeof value === "boolean") return value;
      break;
    case "BLOB":
      if (Buffer.isBuffer(value)) return value;
      if (value instanceof Uint8Array) return Buffer.from(value);
      break;
    case "DATETIME":
      if (value instanceof Date) return value;
      if (typeof value === "bigint") return new Date(Number(value));
      if (typeof value === "number" && Number.isInteger(value)) return new Date(value);
      if (typeof value === "string") {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d;
      }
      break;
  }
  throw new TupleError(`column "${columnName}" expects ${type}, got ${describe(value)}`);
}

/**
 * Order two non-null values. Numeric types compare with affinity (INT and REAL
 * are interchangeable); other type mismatches are a query error rather than a
 * silent coercion.
 */
export function compareValues(a: Exclude<Value, null>, b: Exclude<Value, null>): number {
  if (isNumeric(a) && isNumeric(b)) {
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
    const x = Number(a);
    const y = Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) {
    const x = a.getTime();
    const y = b.getTime();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return Buffer.compare(Buffer.from(a), Buffer.from(b));
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  throw new ExecutionError(`cannot compare ${describe(a)} with ${describe(b)}`);
}

/** Total order used by ORDER BY. NULLs sort first (ascending), like SQLite. */
export function sortCompare(a: Value, b: Value): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareValues(a, b);
}

/** Render a value for display in the REPL / EXPLAIN output. */
export function valueToDisplay(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return v.toString();
}

/** Render a value as a SQL literal (quoting/escaping text and blobs). */
export function valueToLiteral(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return v.toString();
}
