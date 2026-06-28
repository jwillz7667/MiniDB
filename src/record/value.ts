import { ExecutionError } from "../errors.js";
import type { Value } from "./schema.js";

/**
 * Order two non-null values of the same runtime type. Throws on a type mismatch
 * — comparing an INT to TEXT is a query error, not a silent coercion.
 */
export function compareValues(a: Exclude<Value, null>, b: Exclude<Value, null>): number {
  if (typeof a !== typeof b) {
    throw new ExecutionError(`cannot compare ${typeof a} with ${typeof b}`);
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // booleans: false < true
  return Number(a as boolean) - Number(b as boolean);
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
  return v.toString();
}

/** Render a value as a SQL literal (quoting/escaping text). */
export function valueToLiteral(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  return v.toString();
}
