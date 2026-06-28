import type { TableMeta } from "../record/catalog.js";
import { type Column, columnIndex, type Value } from "../record/schema.js";
import { valueToLiteral } from "../record/value.js";
import type { Expr, SortDir } from "../sql/ast.js";
import type { LogicalPlan } from "./logical.js";

const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

/**
 * The physical plan: the optimized logical plan bound to concrete operators,
 * with every column reference resolved to a positional index and each node
 * carrying its output schema. `explain` renders it as the operator tree.
 */
export type PhysicalPlan =
  | PhysSeqScan
  | PhysIndexScan
  | PhysFilter
  | PhysProject
  | PhysSort
  | PhysLimit
  | PhysInsert
  | PhysDelete;

export interface PhysSeqScan {
  readonly op: "SeqScan";
  readonly table: TableMeta;
  readonly columns: Column[];
}
export interface PhysIndexScan {
  readonly op: "IndexScan";
  readonly table: TableMeta;
  readonly columns: Column[];
  readonly column: string;
  readonly root: number;
  readonly lo: bigint;
  readonly hi: bigint;
}
export interface PhysFilter {
  readonly op: "Filter";
  readonly predicate: Expr;
  readonly columns: Column[];
  readonly input: PhysicalPlan;
}
export interface PhysProject {
  readonly op: "Project";
  readonly columns: Column[];
  readonly indices: number[];
  readonly input: PhysicalPlan;
}
export interface PhysSort {
  readonly op: "Sort";
  readonly columns: Column[];
  readonly sortIndex: number;
  readonly dir: SortDir;
  readonly input: PhysicalPlan;
}
export interface PhysLimit {
  readonly op: "Limit";
  readonly columns: Column[];
  readonly limit: number;
  readonly input: PhysicalPlan;
}
export interface PhysInsert {
  readonly op: "Insert";
  readonly table: TableMeta;
  readonly columns: Column[];
  readonly rows: Value[][];
}
export interface PhysDelete {
  readonly op: "Delete";
  readonly table: TableMeta;
  readonly columns: Column[];
  readonly input: PhysicalPlan;
}

export function toPhysical(plan: LogicalPlan): PhysicalPlan {
  switch (plan.kind) {
    case "scan":
      return { op: "SeqScan", table: plan.table, columns: plan.table.columns };
    case "indexScan":
      return {
        op: "IndexScan",
        table: plan.table,
        columns: plan.table.columns,
        column: plan.column,
        root: plan.root,
        lo: plan.lo,
        hi: plan.hi,
      };
    case "filter": {
      const input = toPhysical(plan.input);
      return { op: "Filter", predicate: plan.predicate, columns: input.columns, input };
    }
    case "project": {
      const input = toPhysical(plan.input);
      const indices = plan.columns.map((name) => columnIndex({ columns: input.columns }, name));
      const columns = indices.map((i) => input.columns[i]!);
      return { op: "Project", columns, indices, input };
    }
    case "sort": {
      const input = toPhysical(plan.input);
      const sortIndex = columnIndex({ columns: input.columns }, plan.column);
      return { op: "Sort", columns: input.columns, sortIndex, dir: plan.dir, input };
    }
    case "limit": {
      const input = toPhysical(plan.input);
      return { op: "Limit", columns: input.columns, limit: plan.limit, input };
    }
    case "insert":
      return { op: "Insert", table: plan.table, columns: plan.table.columns, rows: plan.rows };
    case "delete": {
      const input = toPhysical(plan.input);
      return { op: "Delete", table: plan.table, columns: plan.table.columns, input };
    }
  }
}

function childOf(plan: PhysicalPlan): PhysicalPlan | null {
  switch (plan.op) {
    case "Filter":
    case "Project":
    case "Sort":
    case "Limit":
    case "Delete":
      return plan.input;
    default:
      return null;
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
      return `SeqScan ${plan.table.name}`;
    case "IndexScan":
      return `IndexScan ${plan.table.name}.${plan.column} ${rangeLabel(plan.lo, plan.hi)}`;
    case "Filter":
      return `Filter ${printExpr(plan.predicate)}`;
    case "Project":
      return `Project (${plan.columns.map((c) => c.name).join(", ")})`;
    case "Sort":
      return `Sort ${plan.columns[plan.sortIndex]!.name} ${plan.dir}`;
    case "Limit":
      return `Limit ${plan.limit}`;
    case "Insert":
      return `Insert ${plan.table.name} (${plan.rows.length} row${plan.rows.length === 1 ? "" : "s"})`;
    case "Delete":
      return `Delete ${plan.table.name}`;
  }
}

/** Render the operator tree as indented lines, parents above their children. */
export function explain(plan: PhysicalPlan): string[] {
  const lines: string[] = [];
  let node: PhysicalPlan | null = plan;
  let depth = 0;
  while (node) {
    lines.push(`${"  ".repeat(depth)}${nodeLabel(node)}`);
    node = childOf(node);
    depth += 1;
  }
  return lines;
}

export function printExpr(expr: Expr): string {
  switch (expr.kind) {
    case "literal":
      return valueToLiteral(expr.value);
    case "column":
      return expr.name;
    case "compare":
      return `${printExpr(expr.left)} ${expr.op} ${printExpr(expr.right)}`;
    case "logical":
      return `(${printExpr(expr.left)} ${expr.op} ${printExpr(expr.right)})`;
  }
}

// Exposed so the REPL/EXPLAIN tests can recognize the unbounded sentinels.
export { I64_MIN, I64_MAX };
