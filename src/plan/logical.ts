import { INVALID_PAGE } from "../constants.js";
import { PlanError } from "../errors.js";
import type { Catalog, TableMeta } from "../record/catalog.js";
import { columnIndex, type Schema, type Value } from "../record/schema.js";
import { coerceToColumnType } from "../record/value.js";
import type {
  DeleteStmt,
  Expr,
  InsertStmt,
  SelectStmt,
  SortDir,
  UpdateStmt,
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
  | LogicalUpdate
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

/** A single resolved assignment: column position + value expression. */
export interface ResolvedAssignment {
  readonly index: number;
  readonly value: Expr;
}

export interface LogicalUpdate {
  readonly kind: "update";
  readonly table: TableMeta;
  readonly assignments: ResolvedAssignment[];
  readonly input: LogicalPlan;
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

export function buildUpdate(stmt: UpdateStmt, catalog: Catalog): LogicalUpdate {
  const table = catalog.requireTable(stmt.table);
  requireWritable(table);
  if (stmt.assignments.length === 0) throw new PlanError("UPDATE has no assignments");

  const seen = new Set<number>();
  const assignments: ResolvedAssignment[] = stmt.assignments.map((a) => {
    const index = columnIndex(table.schema, a.column); // throws if unknown
    if (seen.has(index)) throw new PlanError(`column "${a.column}" assigned more than once`);
    seen.add(index);
    validateExpr(a.value, table.schema); // value may reference existing columns
    return { index, value: a.value };
  });

  let input: LogicalPlan = { kind: "scan", table };
  if (stmt.where) {
    validateExpr(stmt.where, table.schema);
    input = { kind: "filter", predicate: stmt.where, input };
  }
  return { kind: "update", table, assignments, input };
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
  // Validate (with numeric affinity) at plan time so a bad literal fails before
  // any rows are written; the actual coercion happens again in serialize.
  try {
    coerceToColumnType(col.type, value, col.name);
  } catch (err) {
    throw new PlanError(err instanceof Error ? err.message : String(err));
  }
}
