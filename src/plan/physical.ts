import { PlanError } from "../errors.js";
import type { TableMeta } from "../record/catalog.js";
import { type Column, type ColumnType, type Value } from "../record/schema.js";
import { valueToLiteral } from "../record/value.js";
import type { ColumnRef, Expr, JoinType, SortDir } from "../sql/ast.js";
import type { LogicalPlan, ResolvedAssignment } from "./logical.js";

const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

/**
 * A column in an operator's output: its name and type plus the table/alias it
 * came from, so a reference like `u.id` resolves unambiguously across a join.
 */
export interface PlanColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly table: string;
}

/**
 * The physical plan: the optimized logical plan bound to concrete operators,
 * with every column reference resolved to a positional index and each node
 * carrying its output schema. `explain` renders it as the operator tree.
 */
export type PhysicalPlan =
  | PhysSeqScan
  | PhysIndexScan
  | PhysJoin
  | PhysAggregate
  | PhysFilter
  | PhysProject
  | PhysSort
  | PhysLimit
  | PhysInsert
  | PhysUpdate
  | PhysDelete;

export interface PhysSeqScan {
  readonly op: "SeqScan";
  readonly table: TableMeta;
  readonly columns: PlanColumn[];
}
export interface PhysIndexScan {
  readonly op: "IndexScan";
  readonly table: TableMeta;
  readonly columns: PlanColumn[];
  readonly column: string;
  readonly root: number;
  readonly lo: bigint;
  readonly hi: bigint;
}
export interface PhysJoin {
  readonly op: "NestedLoopJoin" | "HashJoin";
  readonly joinType: JoinType;
  readonly columns: PlanColumn[];
  /** Number of columns contributed by the left input (where right columns begin). */
  readonly leftWidth: number;
  readonly on: Expr;
  /** For HashJoin: equality key positions within the left / right inputs. */
  readonly leftKeyIndex?: number;
  readonly rightKeyIndex?: number;
  readonly left: PhysicalPlan;
  readonly right: PhysicalPlan;
}
/** A resolved aggregate: function, the input column position (-1 for COUNT(*)). */
export interface PhysAgg {
  readonly func: string;
  readonly argIndex: number;
  readonly outType: ColumnType;
}
export interface PhysAggregate {
  readonly op: "Aggregate";
  readonly columns: PlanColumn[];
  readonly groupIndices: number[];
  readonly aggregates: PhysAgg[];
  readonly input: PhysicalPlan;
}
export interface PhysFilter {
  readonly op: "Filter";
  readonly predicate: Expr;
  readonly columns: PlanColumn[];
  readonly input: PhysicalPlan;
}
export interface PhysProject {
  readonly op: "Project";
  readonly columns: PlanColumn[];
  readonly indices: number[];
  readonly input: PhysicalPlan;
}
export interface PhysSort {
  readonly op: "Sort";
  readonly columns: PlanColumn[];
  readonly sortIndex: number;
  readonly dir: SortDir;
  /** When an enclosing LIMIT is known, the sort keeps only this many rows (top-N). */
  readonly limit: number | undefined;
  readonly input: PhysicalPlan;
}
export interface PhysLimit {
  readonly op: "Limit";
  readonly columns: PlanColumn[];
  readonly limit: number;
  readonly input: PhysicalPlan;
}
export interface PhysInsert {
  readonly op: "Insert";
  readonly table: TableMeta;
  readonly columns: PlanColumn[];
  readonly rows: Value[][];
  readonly autoIncrement?: { columnIndex: number; indexRoot: number };
}
export interface PhysUpdate {
  readonly op: "Update";
  readonly table: TableMeta;
  readonly columns: PlanColumn[];
  readonly assignments: ResolvedAssignment[];
  readonly input: PhysicalPlan;
}
export interface PhysDelete {
  readonly op: "Delete";
  readonly table: TableMeta;
  readonly columns: PlanColumn[];
  readonly input: PhysicalPlan;
}

function planColumns(table: TableMeta, alias: string): PlanColumn[] {
  return table.columns.map((c: Column) => ({ name: c.name, type: c.type, table: alias }));
}

/** Resolve a (possibly qualified) reference to a positional index in `columns`. */
export function resolveRef(columns: PlanColumn[], ref: ColumnRef): number {
  const name = ref.name.toLowerCase();
  const table = ref.table?.toLowerCase();
  const matches: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]!;
    if (c.name.toLowerCase() === name && (table === undefined || c.table.toLowerCase() === table)) {
      matches.push(i);
    }
  }
  if (matches.length === 0) {
    throw new PlanError(`unknown column "${ref.table ? `${ref.table}.` : ""}${ref.name}"`);
  }
  if (matches.length > 1) {
    throw new PlanError(`ambiguous column "${ref.name}" (qualify it with a table name)`);
  }
  return matches[0]!;
}

/** Recognize an equi-join `L.a = R.b` and return the per-side key positions. */
function asEquiJoin(
  on: Expr,
  columns: PlanColumn[],
  leftWidth: number,
): { leftKeyIndex: number; rightKeyIndex: number } | null {
  if (on.kind !== "compare" || on.op !== "=") return null;
  if (on.left.kind !== "column" || on.right.kind !== "column") return null;
  const a = resolveRef(columns, on.left);
  const b = resolveRef(columns, on.right);
  const aLeft = a < leftWidth;
  const bLeft = b < leftWidth;
  if (aLeft === bLeft) return null; // both sides reference the same input
  return aLeft
    ? { leftKeyIndex: a, rightKeyIndex: b - leftWidth }
    : { leftKeyIndex: b, rightKeyIndex: a - leftWidth };
}

/**
 * Bind the logical plan to operators. `limitHint` carries a row cap downward
 * from a LIMIT through row-count-preserving Project nodes into a Sort, so
 * `ORDER BY … LIMIT n` keeps only the top n rows instead of buffering everything.
 */
export function toPhysical(plan: LogicalPlan, limitHint?: number): PhysicalPlan {
  switch (plan.kind) {
    case "scan":
      return { op: "SeqScan", table: plan.table, columns: planColumns(plan.table, plan.alias) };
    case "indexScan":
      return {
        op: "IndexScan",
        table: plan.table,
        columns: planColumns(plan.table, plan.alias),
        column: plan.column,
        root: plan.root,
        lo: plan.lo,
        hi: plan.hi,
      };
    case "join": {
      const left = toPhysical(plan.left);
      const right = toPhysical(plan.right);
      const columns = [...left.columns, ...right.columns];
      const leftWidth = left.columns.length;
      const eq = asEquiJoin(plan.on, columns, leftWidth);
      if (eq) {
        return {
          op: "HashJoin",
          joinType: plan.joinType,
          columns,
          leftWidth,
          on: plan.on,
          leftKeyIndex: eq.leftKeyIndex,
          rightKeyIndex: eq.rightKeyIndex,
          left,
          right,
        };
      }
      return { op: "NestedLoopJoin", joinType: plan.joinType, columns, leftWidth, on: plan.on, left, right };
    }
    case "aggregate": {
      const input = toPhysical(plan.input);
      const groupIndices = plan.groupBy.map((ref) => resolveRef(input.columns, ref));
      const groupColumns = groupIndices.map((i) => input.columns[i]!);
      const aggregates: PhysAgg[] = plan.aggregates.map((a) => {
        const argIndex = a.star ? -1 : resolveRef(input.columns, a.arg!);
        const argType = argIndex < 0 ? "INT" : input.columns[argIndex]!.type;
        return { func: a.func, argIndex, outType: aggType(a.func, argType) };
      });
      const aggColumns: PlanColumn[] = plan.aggregates.map((a, k) => ({
        name: a.outName,
        type: aggregates[k]!.outType,
        table: "",
      }));
      return { op: "Aggregate", columns: [...groupColumns, ...aggColumns], groupIndices, aggregates, input };
    }
    case "filter": {
      const input = toPhysical(plan.input);
      return { op: "Filter", predicate: plan.predicate, columns: input.columns, input };
    }
    case "project": {
      const input = toPhysical(plan.input, limitHint); // Project preserves row count
      if (plan.columns === "*") {
        return { op: "Project", columns: input.columns, indices: input.columns.map((_, i) => i), input };
      }
      const indices = plan.columns.map((it) => resolveRef(input.columns, it.ref));
      const columns = plan.columns.map((it, k) => {
        const src = input.columns[indices[k]!]!;
        return { name: it.name, type: src.type, table: src.table };
      });
      return { op: "Project", columns, indices, input };
    }
    case "sort": {
      const input = toPhysical(plan.input);
      const sortIndex = resolveRef(input.columns, plan.column);
      return { op: "Sort", columns: input.columns, sortIndex, dir: plan.dir, limit: limitHint, input };
    }
    case "limit": {
      const input = toPhysical(plan.input, plan.limit);
      return { op: "Limit", columns: input.columns, limit: plan.limit, input };
    }
    case "insert":
      return {
        op: "Insert",
        table: plan.table,
        columns: planColumns(plan.table, plan.table.name),
        rows: plan.rows,
        ...(plan.autoIncrement ? { autoIncrement: plan.autoIncrement } : {}),
      };
    case "update": {
      const input = toPhysical(plan.input);
      return {
        op: "Update",
        table: plan.table,
        columns: planColumns(plan.table, plan.table.name),
        assignments: plan.assignments,
        input,
      };
    }
    case "delete": {
      const input = toPhysical(plan.input);
      return { op: "Delete", table: plan.table, columns: planColumns(plan.table, plan.table.name), input };
    }
  }
}

/** Output type of an aggregate over a column of `argType`. */
function aggType(func: string, argType: ColumnType): ColumnType {
  const numeric = argType === "INT" || argType === "REAL";
  switch (func) {
    case "count":
      return "INT";
    case "sum":
      if (numeric) return argType;
      throw new PlanError(`sum() requires a numeric column, got ${argType}`);
    case "avg":
      if (numeric) return "REAL";
      throw new PlanError(`avg() requires a numeric column, got ${argType}`);
    case "min":
    case "max":
      return argType;
    default:
      throw new PlanError(`unknown aggregate "${func}"`);
  }
}

function children(plan: PhysicalPlan): PhysicalPlan[] {
  switch (plan.op) {
    case "Aggregate":
    case "Filter":
    case "Project":
    case "Sort":
    case "Limit":
    case "Update":
    case "Delete":
      return [plan.input];
    case "NestedLoopJoin":
    case "HashJoin":
      return [plan.left, plan.right];
    default:
      return [];
  }
}

function rangeLabel(lo: bigint, hi: bigint): string {
  const loText = lo === I64_MIN ? "-inf" : lo.toString();
  const hiText = hi === I64_MAX ? "+inf" : hi.toString();
  return `[${loText}, ${hiText}]`;
}

function nodeLabel(plan: PhysicalPlan): string {
  switch (plan.op) {
    case "SeqScan":
      return `SeqScan ${labelTable(plan.table.name, plan.columns)}`;
    case "IndexScan":
      return `IndexScan ${plan.table.name}.${plan.column} ${rangeLabel(plan.lo, plan.hi)}`;
    case "NestedLoopJoin":
      return `NestedLoopJoin (${plan.joinType}) ON ${printExpr(plan.on)}`;
    case "HashJoin":
      return `HashJoin (${plan.joinType}) ON ${printExpr(plan.on)}`;
    case "Aggregate": {
      const by = plan.groupIndices.map((i) => plan.columns[i]!.name);
      const aggs = plan.aggregates.map((a) => a.func);
      return `Aggregate ${by.length ? `by (${by.join(", ")}) ` : ""}[${aggs.join(", ")}]`;
    }
    case "Filter":
      return `Filter ${printExpr(plan.predicate)}`;
    case "Project":
      return `Project (${plan.columns.map((c) => c.name).join(", ")})`;
    case "Sort":
      return (
        `Sort ${plan.columns[plan.sortIndex]!.name} ${plan.dir}` +
        (plan.limit !== undefined ? ` (top ${plan.limit})` : "")
      );
    case "Limit":
      return `Limit ${plan.limit}`;
    case "Insert":
      return `Insert ${plan.table.name} (${plan.rows.length} row${plan.rows.length === 1 ? "" : "s"})`;
    case "Update": {
      const sets = plan.assignments
        .map((a) => `${plan.columns[a.index]!.name} = ${printExpr(a.value)}`)
        .join(", ");
      return `Update ${plan.table.name} SET ${sets}`;
    }
    case "Delete":
      return `Delete ${plan.table.name}`;
  }
}

/** Show the alias next to the table name when they differ (`users u`). */
function labelTable(name: string, columns: PlanColumn[]): string {
  const alias = columns[0]?.table;
  return alias && alias !== name ? `${name} ${alias}` : name;
}

/** Render the operator tree as indented lines, parents above their children. */
export function explain(plan: PhysicalPlan): string[] {
  const lines: string[] = [];
  const walk = (node: PhysicalPlan, depth: number): void => {
    lines.push(`${"  ".repeat(depth)}${nodeLabel(node)}`);
    for (const child of children(node)) walk(child, depth + 1);
  };
  walk(plan, 0);
  return lines;
}

export function printExpr(expr: Expr): string {
  switch (expr.kind) {
    case "literal":
      return valueToLiteral(expr.value);
    case "param":
      return `?${expr.index + 1}`;
    case "column":
      return expr.table ? `${expr.table}.${expr.name}` : expr.name;
    case "call":
      return `${expr.func}(${expr.star ? "*" : expr.arg ? printExpr(expr.arg) : ""})`;
    case "compare":
      return `${printExpr(expr.left)} ${expr.op} ${printExpr(expr.right)}`;
    case "logical":
      return `(${printExpr(expr.left)} ${expr.op} ${printExpr(expr.right)})`;
  }
}

// Exposed so the REPL/EXPLAIN tests can recognize the unbounded sentinels.
export { I64_MIN, I64_MAX };
