import { ExecutionError } from "../errors.js";
import type { Column, Value } from "../record/schema.js";
import { compareValues } from "../record/value.js";
import type { CompareOp, Expr } from "../sql/ast.js";

/** A compiled expression: evaluate it against a positional row of values. */
export type CompiledExpr = (values: Value[]) => Value;

function resolveColumn(columns: Column[], name: string): number {
  const idx = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  if (idx < 0) throw new ExecutionError(`unknown column "${name}"`);
  return idx;
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
export function compileExpr(expr: Expr, columns: Column[]): CompiledExpr {
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
      const idx = resolveColumn(columns, expr.name);
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
export function compilePredicate(expr: Expr, columns: Column[]): (values: Value[]) => boolean {
  const compiled = compileExpr(expr, columns);
  return (values) => asBool(compiled(values));
}
