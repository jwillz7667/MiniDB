import { INVALID_PAGE } from "../constants.js";
import { PlanError } from "../errors.js";
import type { Catalog, TableMeta } from "../record/catalog.js";
import { columnIndex, type Schema, type Value } from "../record/schema.js";
import type {
  DeleteStmt,
  Expr,
  InsertStmt,
  SelectStmt,
  SortDir,
  ValueExpr,
} from "../sql/ast.js";

/**
 * The logical plan: a tree describing WHAT to compute, independent of access
 * methods. The optimizer rewrites it (e.g. turning a scan+filter into an index
 * scan); `physical.ts` then binds it to concrete operators.
 */
export type LogicalPlan =
  | LogicalScan
  | LogicalIndexScan
  | LogicalFilter
  | LogicalProject
  | LogicalSort
  | LogicalLimit
  | LogicalInsert
  | LogicalDelete;

export interface LogicalScan {
  readonly kind: "scan";
  readonly table: TableMeta;
}

/** Produced only by the optimizer when a predicate hits an indexed column. */
export interface LogicalIndexScan {
  readonly kind: "indexScan";
  readonly table: TableMeta;
  readonly column: string;
  readonly root: number;
  readonly lo: bigint;
  readonly hi: bigint;
}

export interface LogicalFilter {
  readonly kind: "filter";
  readonly predicate: Expr;
  readonly input: LogicalPlan;
}

export interface LogicalProject {
  readonly kind: "project";
  readonly columns: string[];
  readonly input: LogicalPlan;
}

export interface LogicalSort {
  readonly kind: "sort";
  readonly column: string;
  readonly dir: SortDir;
  readonly input: LogicalPlan;
}

export interface LogicalLimit {
  readonly kind: "limit";
  readonly limit: number;
  readonly input: LogicalPlan;
}

export interface LogicalInsert {
  readonly kind: "insert";
  readonly table: TableMeta;
  /** Rows already aligned to the table's full column order, NULLs for defaults. */
  readonly rows: Value[][];
}

export interface LogicalDelete {
  readonly kind: "delete";
  readonly table: TableMeta;
  readonly input: LogicalPlan;
}

function requireWritable(table: TableMeta): void {
  if (table.pkRoot === INVALID_PAGE) {
    throw new PlanError(`"${table.name}" is a system table and cannot be modified`);
  }
}

/** Verify every column reference in an expression exists in the schema. */
function validateExpr(expr: Expr, schema: Schema): void {
  switch (expr.kind) {
    case "literal":
      return;
    case "param":
      throw new PlanError("unbound parameter in query (use a prepared statement)");
    case "column":
      columnIndex(schema, expr.name); // throws if unknown
      return;
    case "compare":
    case "logical":
      validateExpr(expr.left, schema);
      validateExpr(expr.right, schema);
      return;
  }
}

export function buildSelect(stmt: SelectStmt, catalog: Catalog): LogicalPlan {
  const table = catalog.requireTable(stmt.table);
  let plan: LogicalPlan = { kind: "scan", table };

  if (stmt.where) {
    validateExpr(stmt.where, table.schema);
    plan = { kind: "filter", predicate: stmt.where, input: plan };
  }

  // Sort before project so an ORDER BY column need not appear in the projection.
  if (stmt.orderBy) {
    columnIndex(table.schema, stmt.orderBy.column);
    plan = { kind: "sort", column: stmt.orderBy.column, dir: stmt.orderBy.dir, input: plan };
  }

  const columns =
    stmt.columns === "*" ? table.columns.map((c) => c.name) : stmt.columns;
  for (const name of columns) columnIndex(table.schema, name); // validate
  plan = { kind: "project", columns, input: plan };

  if (stmt.limit !== null) {
    plan = { kind: "limit", limit: stmt.limit, input: plan };
  }
  return plan;
}

export function buildInsert(stmt: InsertStmt, catalog: Catalog): LogicalInsert {
  const table = catalog.requireTable(stmt.table);
  requireWritable(table);

  const targetNames = stmt.columns ?? table.columns.map((c) => c.name);
  const targetIndices = targetNames.map((name) => columnIndex(table.schema, name));
  const provided = new Set(targetIndices);

  // Every column omitted from the INSERT must accept NULL.
  table.columns.forEach((col, i) => {
    if (!provided.has(i) && !col.nullable) {
      throw new PlanError(`column "${col.name}" has no default and was not provided`);
    }
  });

  const rows = stmt.rows.map((items) => {
    if (items.length !== targetNames.length) {
      throw new PlanError(
        `INSERT has ${items.length} values for ${targetNames.length} columns`,
      );
    }
    const full: Value[] = table.columns.map(() => null);
    items.forEach((item, j) => {
      const value = literalOf(item);
      const schemaIdx = targetIndices[j]!;
      checkValueType(table, schemaIdx, value);
      full[schemaIdx] = value;
    });
    return full;
  });

  return { kind: "insert", table, rows };
}

export function buildDelete(stmt: DeleteStmt, catalog: Catalog): LogicalDelete {
  const table = catalog.requireTable(stmt.table);
  requireWritable(table);

  let input: LogicalPlan = { kind: "scan", table };
  if (stmt.where) {
    validateExpr(stmt.where, table.schema);
    input = { kind: "filter", predicate: stmt.where, input };
  }
  return { kind: "delete", table, input };
}

/** Extract the literal value from an INSERT value slot (params are bound earlier). */
function literalOf(item: ValueExpr): Value {
  if (item.kind === "param") {
    throw new PlanError("unbound parameter in INSERT (use a prepared statement)");
  }
  return item.value;
}

function checkValueType(table: TableMeta, schemaIdx: number, value: Value): void {
  const col = table.columns[schemaIdx]!;
  if (value === null) {
    if (!col.nullable) throw new PlanError(`column "${col.name}" is NOT NULL`);
    return;
  }
  const ok =
    (col.type === "INT" && typeof value === "bigint") ||
    (col.type === "TEXT" && typeof value === "string") ||
    (col.type === "BOOL" && typeof value === "boolean");
  if (!ok) {
    throw new PlanError(`column "${col.name}" expects ${col.type}, got ${typeof value}`);
  }
}
