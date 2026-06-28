import { BindError } from "../errors.js";
import type { LiteralValue } from "./ast.js";
import type {
  DeleteStmt,
  Expr,
  ExplainStmt,
  InsertStmt,
  SelectStmt,
  Statement,
  ValueExpr,
} from "./ast.js";

/**
 * Values a caller may bind to a `?` placeholder. JS `number` is accepted as a
 * convenience and coerced to a `bigint` when it is an exact integer (the engine
 * stores INT as bigint end to end); a non-integer number is rejected until a
 * floating type exists, so precision is never silently lost.
 */
export type BindValue = bigint | number | boolean | string | null;

/**
 * Substitute bound values for every `?` placeholder in a statement, producing a
 * new, fully-literal statement that the planner can consume unchanged. The input
 * AST is never mutated, so a prepared statement can be re-bound and re-run.
 *
 * Throws `BindError` if the number of supplied values does not match the number
 * of placeholders, so a mismatched call fails loudly instead of binding NULLs.
 */
export function bindStatement(
  stmt: Statement,
  params: readonly BindValue[],
  paramCount: number,
): Statement {
  if (params.length !== paramCount) {
    throw new BindError(
      `statement expects ${paramCount} parameter${paramCount === 1 ? "" : "s"} but ${params.length} ${
        params.length === 1 ? "was" : "were"
      } supplied`,
    );
  }
  const literals = params.map(coerce);
  return rewrite(stmt, literals);
}

/** Convert a caller-supplied bind value into an on-engine literal value. */
function coerce(value: BindValue, i: number): LiteralValue {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new BindError(
        `parameter ${i + 1} is the non-integer number ${value}; pass a bigint or string instead`,
      );
    }
    return BigInt(value);
  }
  // bigint | boolean | string | null pass through unchanged.
  return value;
}

function rewrite(stmt: Statement, params: readonly LiteralValue[]): Statement {
  switch (stmt.kind) {
    case "select":
      return rewriteSelect(stmt, params);
    case "insert":
      return rewriteInsert(stmt, params);
    case "delete":
      return rewriteDelete(stmt, params);
    case "explain":
      return rewriteExplain(stmt, params);
    case "createTable":
    case "createIndex":
    case "begin":
    case "commit":
    case "rollback":
      return stmt; // no value positions, nothing to bind
  }
}

function rewriteSelect(stmt: SelectStmt, params: readonly LiteralValue[]): SelectStmt {
  return stmt.where === null ? stmt : { ...stmt, where: bindExpr(stmt.where, params) };
}

function rewriteDelete(stmt: DeleteStmt, params: readonly LiteralValue[]): DeleteStmt {
  return stmt.where === null ? stmt : { ...stmt, where: bindExpr(stmt.where, params) };
}

function rewriteExplain(stmt: ExplainStmt, params: readonly LiteralValue[]): ExplainStmt {
  return { ...stmt, statement: rewrite(stmt.statement, params) as ExplainStmt["statement"] };
}

function rewriteInsert(stmt: InsertStmt, params: readonly LiteralValue[]): InsertStmt {
  const rows = stmt.rows.map((row) =>
    row.map<ValueExpr>((item) =>
      item.kind === "param" ? { kind: "literal", value: params[item.index]! } : item,
    ),
  );
  return { ...stmt, rows };
}

/** Replace every `param` node in an expression with its bound literal. */
export function bindExpr(expr: Expr, params: readonly LiteralValue[]): Expr {
  switch (expr.kind) {
    case "param":
      return { kind: "literal", value: params[expr.index]! };
    case "literal":
    case "column":
      return expr;
    case "compare":
      return { ...expr, left: bindExpr(expr.left, params), right: bindExpr(expr.right, params) };
    case "logical":
      return { ...expr, left: bindExpr(expr.left, params), right: bindExpr(expr.right, params) };
  }
}
