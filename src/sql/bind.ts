import { BindError } from "../errors.js";
import type { LiteralValue } from "./ast.js";
import type {
  DeleteStmt,
  Expr,
  ExplainStmt,
  InsertStmt,
  SelectStmt,
  Statement,
  UpdateStmt,
  ValueExpr,
} from "./ast.js";

/**
 * Values a caller may bind to a `?` placeholder. An exact-integer JS `number` is
 * normalized to `bigint` so it lines up with INT columns and index ranges; other
 * numbers stay `number` (REAL). `Buffer`/`Uint8Array` bind to BLOB columns and
 * `Date` to DATETIME columns. Final type checking happens per column when the
 * value is written or compared.
 */
export type BindValue = bigint | number | boolean | string | Buffer | Date | null;

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

/**
 * Normalize a caller-supplied bind value into a literal. An exact-integer number
 * becomes a bigint (so it matches INT columns and indexes); everything else
 * passes through and is range/type-checked later against the target column.
 */
function coerce(value: BindValue): LiteralValue {
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return value;
}

function rewrite(stmt: Statement, params: readonly LiteralValue[]): Statement {
  switch (stmt.kind) {
    case "select":
      return rewriteSelect(stmt, params);
    case "insert":
      return rewriteInsert(stmt, params);
    case "update":
      return rewriteUpdate(stmt, params);
    case "delete":
      return rewriteDelete(stmt, params);
    case "explain":
      return rewriteExplain(stmt, params);
    case "createTable":
    case "createIndex":
    case "vacuum":
    case "begin":
    case "commit":
    case "rollback":
      return stmt; // no value positions, nothing to bind
  }
}

function rewriteSelect(stmt: SelectStmt, params: readonly LiteralValue[]): SelectStmt {
  const joins = stmt.from.joins.map((j) => ({ ...j, on: bindExpr(j.on, params) }));
  const columns =
    stmt.columns === "*"
      ? "*"
      : stmt.columns.map((item) => ({ ...item, expr: bindExpr(item.expr, params) }));
  return {
    ...stmt,
    columns,
    from: { ...stmt.from, joins },
    where: stmt.where === null ? null : bindExpr(stmt.where, params),
    having: stmt.having === null ? null : bindExpr(stmt.having, params),
  };
}

function rewriteDelete(stmt: DeleteStmt, params: readonly LiteralValue[]): DeleteStmt {
  return stmt.where === null ? stmt : { ...stmt, where: bindExpr(stmt.where, params) };
}

function rewriteUpdate(stmt: UpdateStmt, params: readonly LiteralValue[]): UpdateStmt {
  return {
    ...stmt,
    assignments: stmt.assignments.map((a) => ({ ...a, value: bindExpr(a.value, params) })),
    where: stmt.where === null ? null : bindExpr(stmt.where, params),
  };
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
    case "call":
      return expr.arg === null ? expr : { ...expr, arg: bindExpr(expr.arg, params) };
    case "compare":
      return { ...expr, left: bindExpr(expr.left, params), right: bindExpr(expr.right, params) };
    case "logical":
      return { ...expr, left: bindExpr(expr.left, params), right: bindExpr(expr.right, params) };
  }
}
