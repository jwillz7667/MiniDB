import { INVALID_PAGE } from "../constants.js";
import { PlanError } from "../errors.js";
import type { Catalog, TableMeta } from "../record/catalog.js";
import { columnIndex, type Schema, type Value } from "../record/schema.js";
import { coerceToColumnType } from "../record/value.js";
import type {
  CallExpr,
  ColumnExpr,
  ColumnRef,
  DeleteStmt,
  Expr,
  InsertStmt,
  JoinType,
  SelectItem,
  SelectStmt,
  SortDir,
  TableRef,
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
  | LogicalJoin
  | LogicalAggregate
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
  /** Name columns are qualified by (the FROM alias, or the table name). */
  readonly alias: string;
}

/** Produced only by the optimizer when a predicate hits an indexed column. */
export interface LogicalIndexScan {
  readonly kind: "indexScan";
  readonly table: TableMeta;
  readonly alias: string;
  readonly column: string;
  readonly root: number;
  readonly lo: bigint;
  readonly hi: bigint;
}

export interface LogicalJoin {
  readonly kind: "join";
  readonly joinType: JoinType;
  readonly on: Expr;
  readonly left: LogicalPlan;
  readonly right: LogicalPlan;
}

export interface LogicalFilter {
  readonly kind: "filter";
  readonly predicate: Expr;
  readonly input: LogicalPlan;
}

/** One aggregate to compute per group. */
export interface AggSpec {
  readonly func: string; // count | sum | avg | min | max
  readonly star: boolean; // count(*)
  readonly arg: ColumnRef | null;
  /** Synthetic output column name ($agg0, …) used to reference the result. */
  readonly outName: string;
}

export interface LogicalAggregate {
  readonly kind: "aggregate";
  readonly groupBy: ColumnRef[];
  readonly aggregates: AggSpec[];
  readonly input: LogicalPlan;
}

/** A projected output column: where it comes from and its display name. */
export interface ProjectItem {
  readonly ref: ColumnRef;
  readonly name: string;
}

export interface LogicalProject {
  readonly kind: "project";
  /** Projected items, or "*" for every column of the input. */
  readonly columns: ProjectItem[] | "*";
  readonly input: LogicalPlan;
}

export interface LogicalSort {
  readonly kind: "sort";
  readonly column: ColumnRef;
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
  /** Rows aligned to the table's full column order, with DEFAULTs already applied. */
  readonly rows: Value[][];
  /** When set, an AUTOINCREMENT column is filled from its index at execution. */
  readonly autoIncrement?: { columnIndex: number; indexRoot: number };
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
    case "call":
      throw new PlanError(`aggregate "${expr.func}" is not allowed in this clause`);
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

function buildScan(ref: TableRef, catalog: Catalog): LogicalScan {
  const table = catalog.requireTable(ref.table);
  return { kind: "scan", table, alias: ref.alias ?? table.name };
}

const AGGREGATE_FUNCS = new Set(["count", "sum", "avg", "min", "max"]);

export function buildSelect(stmt: SelectStmt, catalog: Catalog): LogicalPlan {
  // Build the FROM tree left-deep: base, then fold each join onto the result.
  // Column references are resolved against the combined schema in the physical
  // layer, where every table's columns (and aliases) are known.
  let plan: LogicalPlan = buildScan(stmt.from.base, catalog);
  for (const join of stmt.from.joins) {
    const right = buildScan(join.right, catalog);
    plan = { kind: "join", joinType: join.type, on: join.on, left: plan, right };
  }

  if (stmt.where) plan = { kind: "filter", predicate: stmt.where, input: plan };

  return stmt.groupBy !== null || hasAggregate(stmt)
    ? buildAggregateSelect(stmt, plan)
    : buildSimpleSelect(stmt, plan);
}

function buildSimpleSelect(stmt: SelectStmt, input: LogicalPlan): LogicalPlan {
  let plan = input;
  // Sort before project so an ORDER BY column need not appear in the projection.
  if (stmt.orderBy) plan = { kind: "sort", column: stmt.orderBy.column, dir: stmt.orderBy.dir, input: plan };

  const columns =
    stmt.columns === "*" ? "*" : stmt.columns.map((item) => simpleProjectItem(item));
  plan = { kind: "project", columns, input: plan };

  if (stmt.limit !== null) plan = { kind: "limit", limit: stmt.limit, input: plan };
  return plan;
}

function buildAggregateSelect(stmt: SelectStmt, input: LogicalPlan): LogicalPlan {
  if (stmt.columns === "*") {
    throw new PlanError("SELECT * is not allowed with GROUP BY or aggregates; list columns explicitly");
  }
  const groupBy = stmt.groupBy ?? [];
  const aggregates = collectAggregates(stmt);

  let plan: LogicalPlan = { kind: "aggregate", groupBy, aggregates, input };

  if (stmt.having) {
    // HAVING may reference SELECT aliases (e.g. `HAVING n > 1` where `n` aliases
    // an aggregate), which we map to the underlying aggregate/group column.
    const aliases = new Map<string, ColumnRef>();
    for (const item of stmt.columns) {
      if (!item.alias) continue;
      const key = item.alias.toLowerCase();
      if (item.expr.kind === "call") {
        aliases.set(key, { table: null, name: lookupAgg(item.expr, aggregates).outName });
      } else if (item.expr.kind === "column") {
        aliases.set(key, { table: item.expr.table, name: item.expr.name });
      }
    }
    plan = { kind: "filter", predicate: rewriteHaving(stmt.having, aggregates, aliases), input: plan };
  }

  const items = stmt.columns.map((item) => aggregateProjectItem(item, aggregates, groupBy));
  plan = { kind: "project", columns: items, input: plan };

  // For aggregate queries, sort the projected output (so ORDER BY can use an
  // aggregate's alias); a group column must be selected to be ordered by.
  if (stmt.orderBy) plan = { kind: "sort", column: stmt.orderBy.column, dir: stmt.orderBy.dir, input: plan };
  if (stmt.limit !== null) plan = { kind: "limit", limit: stmt.limit, input: plan };
  return plan;
}

// ---- aggregate helpers ----------------------------------------------------

function hasAggregate(stmt: SelectStmt): boolean {
  if (stmt.columns !== "*" && stmt.columns.some((i) => exprHasCall(i.expr))) return true;
  return stmt.having !== null && exprHasCall(stmt.having);
}

function exprHasCall(expr: Expr): boolean {
  switch (expr.kind) {
    case "call":
      return true;
    case "compare":
    case "logical":
      return exprHasCall(expr.left) || exprHasCall(expr.right);
    default:
      return false;
  }
}

/** Key identifying a distinct aggregate so equal ones share one computation. */
function aggKey(call: CallExpr): string {
  return `${call.func}|${call.star ? "*" : refKey(asColumn(call))}`;
}

function refKey(ref: ColumnRef): string {
  return `${(ref.table ?? "").toLowerCase()}.${ref.name.toLowerCase()}`;
}

function asColumn(call: CallExpr): ColumnRef {
  if (call.star || call.arg === null || call.arg.kind !== "column") {
    throw new PlanError(`aggregate "${call.func}" requires a single column argument`);
  }
  return { table: call.arg.table, name: call.arg.name };
}

/** Gather every distinct aggregate used in the SELECT list and HAVING. */
function collectAggregates(stmt: SelectStmt): AggSpec[] {
  const byKey = new Map<string, AggSpec>();
  const visit = (expr: Expr): void => {
    if (expr.kind === "call") {
      if (!AGGREGATE_FUNCS.has(expr.func)) throw new PlanError(`unknown function "${expr.func}"`);
      if (expr.star && expr.func !== "count") {
        throw new PlanError(`${expr.func}(*) is not supported; use ${expr.func}(<column>)`);
      }
      const key = aggKey(expr);
      if (!byKey.has(key)) {
        byKey.set(key, {
          func: expr.func,
          star: expr.star,
          arg: expr.star ? null : asColumn(expr),
          outName: `$agg${byKey.size}`,
        });
      }
    } else if (expr.kind === "compare" || expr.kind === "logical") {
      visit(expr.left);
      visit(expr.right);
    }
  };
  if (stmt.columns !== "*") for (const item of stmt.columns) visit(item.expr);
  if (stmt.having) visit(stmt.having);
  return [...byKey.values()];
}

/**
 * Rewrite a HAVING predicate against the aggregate output: aggregate calls
 * become references to their computed columns, and unqualified column names that
 * match a SELECT alias are replaced with the aliased aggregate/group column.
 */
function rewriteHaving(expr: Expr, aggregates: AggSpec[], aliases: Map<string, ColumnRef>): Expr {
  switch (expr.kind) {
    case "call":
      return { kind: "column", table: null, name: lookupAgg(expr, aggregates).outName };
    case "column": {
      if (expr.table === null) {
        const sub = aliases.get(expr.name.toLowerCase());
        if (sub) return { kind: "column", table: sub.table, name: sub.name };
      }
      return expr;
    }
    case "compare":
      return { ...expr, left: rewriteHaving(expr.left, aggregates, aliases), right: rewriteHaving(expr.right, aggregates, aliases) };
    case "logical":
      return { ...expr, left: rewriteHaving(expr.left, aggregates, aliases), right: rewriteHaving(expr.right, aggregates, aliases) };
    default:
      return expr;
  }
}

function lookupAgg(call: CallExpr, aggregates: AggSpec[]): AggSpec {
  const key = aggKey(call);
  const spec = aggregates.find((a) => `${a.func}|${a.star ? "*" : refKey(a.arg!)}` === key);
  if (!spec) throw new PlanError(`aggregate ${call.func} not collected`);
  return spec;
}

function simpleProjectItem(item: SelectItem): ProjectItem {
  if (item.expr.kind !== "column") {
    throw new PlanError("only column references are allowed here (did you mean to add GROUP BY?)");
  }
  const col = item.expr;
  return { ref: { table: col.table, name: col.name }, name: item.alias ?? col.name };
}

function aggregateProjectItem(item: SelectItem, aggregates: AggSpec[], groupBy: ColumnRef[]): ProjectItem {
  if (item.expr.kind === "call") {
    const spec = lookupAgg(item.expr, aggregates);
    return { ref: { table: null, name: spec.outName }, name: item.alias ?? defaultAggName(spec) };
  }
  if (item.expr.kind === "column") {
    const col: ColumnExpr = item.expr;
    if (!groupBy.some((g) => sameRef(g, col))) {
      throw new PlanError(`column "${col.name}" must appear in GROUP BY or be used in an aggregate`);
    }
    return { ref: { table: col.table, name: col.name }, name: item.alias ?? col.name };
  }
  throw new PlanError("a grouped SELECT list may only contain group columns and aggregates");
}

function defaultAggName(spec: AggSpec): string {
  return spec.func;
}

function sameRef(a: ColumnRef, b: { table: string | null; name: string }): boolean {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false;
  return a.table === null || b.table === null || a.table.toLowerCase() === b.table.toLowerCase();
}

export function buildInsert(stmt: InsertStmt, catalog: Catalog): LogicalInsert {
  const table = catalog.requireTable(stmt.table);
  requireWritable(table);

  const targetNames = stmt.columns ?? table.columns.map((c) => c.name);
  const targetIndices = targetNames.map((name) => columnIndex(table.schema, name));
  const provided = new Set(targetIndices);

  // A column omitted from the INSERT must have a DEFAULT, be AUTOINCREMENT, or
  // accept NULL — otherwise there is no value to write.
  table.columns.forEach((col, i) => {
    if (provided.has(i) || col.default !== undefined || col.autoIncrement || col.nullable) return;
    throw new PlanError(`column "${col.name}" has no default and was not provided`);
  });

  const rows = stmt.rows.map((items) => {
    if (items.length !== targetNames.length) {
      throw new PlanError(
        `INSERT has ${items.length} values for ${targetNames.length} columns`,
      );
    }
    // Start each row from its column DEFAULTs (NULL when none), then overlay the
    // provided values. AUTOINCREMENT columns stay NULL here and are filled later.
    const full: Value[] = table.columns.map((col) => (col.default !== undefined ? col.default : null));
    items.forEach((item, j) => {
      const value = literalOf(item);
      const schemaIdx = targetIndices[j]!;
      checkValueType(table, schemaIdx, value);
      full[schemaIdx] = value;
    });
    return full;
  });

  const autoCol = table.columns.findIndex((c) => c.autoIncrement);
  if (autoCol < 0) return { kind: "insert", table, rows };

  const index = catalog.findIndex(table.name, table.columns[autoCol]!.name);
  if (!index) throw new PlanError(`AUTOINCREMENT column "${table.columns[autoCol]!.name}" has no index`);
  return { kind: "insert", table, rows, autoIncrement: { columnIndex: autoCol, indexRoot: index.root } };
}

export function buildDelete(stmt: DeleteStmt, catalog: Catalog): LogicalDelete {
  const table = catalog.requireTable(stmt.table);
  requireWritable(table);

  let input: LogicalPlan = { kind: "scan", table, alias: table.name };
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

  let input: LogicalPlan = { kind: "scan", table, alias: table.name };
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
