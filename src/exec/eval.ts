import { ExecutionError } from "../errors.js";
import type { Value } from "../record/schema.js";
import { compareValues } from "../record/value.js";
import type { CompareOp, Expr } from "../sql/ast.js";
import type { PlanColumn } from "../plan/physical.js";

/** A compiled expression: evaluate it against a positional row of values. */
export type CompiledExpr = (values: Value[]) => Value;

/** Resolve a (possibly qualified) column reference to a positional index. */
function resolveColumn(columns: PlanColumn[], table: string | null, name: string): number {
  const lname = name.toLowerCase();
  const ltable = table?.toLowerCase();
  let found = -1;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]!;
    if (c.name.toLowerCase() === lname && (ltable === undefined || c.table.toLowerCase() === ltable)) {
      if (found >= 0) throw new ExecutionError(`ambiguous column "${name}" (qualify it with a table name)`);
      found = i;
    }
  }
  if (found < 0) throw new ExecutionError(`unknown column "${table ? `${table}.` : ""}${name}"`);
  return found;
}

function applyCompare(op: CompareOp, a: Value, b: Value): boolean {
  // SQL three-valued logic, simplified: any comparison involving NULL is "not
  // true", so the row is excluded.
  if (a === null || b === null) return false;
  const c = compareValues(a, b);
  switch (op) {
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
  }
}

/** Treat a value as a predicate result: only the boolean `true` is true. */
function asBool(v: Value): boolean {
  return v === true;
}

/**
 * Compile an expression into a fast closure, resolving column references to
 * positional indices up front so per-row evaluation does no name lookups.
 */
export function compileExpr(expr: Expr, columns: PlanColumn[]): CompiledExpr {
  switch (expr.kind) {
    case "literal": {
      const v = expr.value;
      return () => v;
    }
    case "param":
      // Binding replaces every placeholder before planning; reaching here means
      // a statement was run without being bound.
      throw new ExecutionError(`unbound parameter ?${expr.index + 1} (use a prepared statement)`);
    case "column": {
      const idx = resolveColumn(columns, expr.table, expr.name);
      return (values) => values[idx]!;
    }
    case "compare": {
      const left = compileExpr(expr.left, columns);
      const right = compileExpr(expr.right, columns);
      const op = expr.op;
      return (values) => applyCompare(op, left(values), right(values));
    }
    case "logical": {
      const left = compileExpr(expr.left, columns);
      const right = compileExpr(expr.right, columns);
      if (expr.op === "AND") {
        return (values) => asBool(left(values)) && asBool(right(values));
      }
      return (values) => asBool(left(values)) || asBool(right(values));
    }
  }
}

/** Compile an expression used as a WHERE predicate (result coerced to boolean). */
export function compilePredicate(expr: Expr, columns: PlanColumn[]): (values: Value[]) => boolean {
  const compiled = compileExpr(expr, columns);
  return (values) => asBool(compiled(values));
}
