import type { Catalog, TableMeta } from "../record/catalog.js";
import type { CompareOp, Expr } from "../sql/ast.js";
import type { LogicalIndexScan, LogicalPlan, LogicalScan } from "./logical.js";

/** Inclusive bounds for an unbounded side of an index range (full INT domain). */
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

/**
 * Two visible rewrite rules:
 *
 *   1. Predicate pushdown — a conjunctive WHERE is split, and a "sargable"
 *      conjunct (column <op> int-literal on an indexed column) is pushed down
 *      into the scan as a key range; the remaining conjuncts stay as a Filter.
 *   2. Index selection — that pushed-down conjunct turns a SeqScan into an
 *      IndexScan over the chosen B+Tree.
 *
 * EXPLAIN shows the result: with an index, `IndexScan` plus a residual `Filter`;
 * without one, `SeqScan` plus the full `Filter`.
 */
export function optimize(plan: LogicalPlan, catalog: Catalog): LogicalPlan {
  switch (plan.kind) {
    case "scan":
    case "indexScan":
    case "insert":
      return plan;
    case "filter": {
      const input = optimize(plan.input, catalog);
      if (input.kind === "scan") return selectIndex(plan.predicate, input, catalog);
      return { kind: "filter", predicate: plan.predicate, input };
    }
    case "join":
      return { ...plan, left: optimize(plan.left, catalog), right: optimize(plan.right, catalog) };
    case "project":
    case "sort":
    case "limit":
    case "update":
    case "delete":
      return { ...plan, input: optimize(plan.input, catalog) };
  }
}

/** Flatten an AND-chain into its conjuncts; any non-AND expr is a single conjunct. */
function splitConjuncts(expr: Expr): Expr[] {
  if (expr.kind === "logical" && expr.op === "AND") {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

function combineConjuncts(conjuncts: Expr[]): Expr {
  return conjuncts.reduce((left, right) => ({ kind: "logical", op: "AND", left, right }));
}

interface Sargable {
  column: string;
  root: number;
  lo: bigint;
  hi: bigint;
}

function selectIndex(predicate: Expr, scan: LogicalScan, catalog: Catalog): LogicalPlan {
  const conjuncts = splitConjuncts(predicate);
  for (let i = 0; i < conjuncts.length; i++) {
    const hit = asSargable(conjuncts[i]!, scan.table, catalog);
    if (!hit) continue;

    const indexScan: LogicalIndexScan = {
      kind: "indexScan",
      table: scan.table,
      alias: scan.alias,
      column: hit.column,
      root: hit.root,
      lo: hit.lo,
      hi: hit.hi,
    };
    const residual = conjuncts.filter((_, j) => j !== i);
    return residual.length === 0
      ? indexScan
      : { kind: "filter", predicate: combineConjuncts(residual), input: indexScan };
  }
  return { kind: "filter", predicate, input: scan };
}

const FLIP: Record<CompareOp, CompareOp> = {
  "=": "=",
  "!=": "!=",
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

/** Recognize `col <op> int` / `int <op> col` on an indexed INT column. */
function asSargable(expr: Expr, table: TableMeta, catalog: Catalog): Sargable | null {
  if (expr.kind !== "compare") return null;

  let column: string;
  let op: CompareOp;
  let value: bigint;
  if (expr.left.kind === "column" && expr.right.kind === "literal") {
    column = expr.left.name;
    op = expr.op;
    if (typeof expr.right.value !== "bigint") return null;
    value = expr.right.value;
  } else if (expr.left.kind === "literal" && expr.right.kind === "column") {
    column = expr.right.name;
    op = FLIP[expr.op];
    if (typeof expr.left.value !== "bigint") return null;
    value = expr.left.value;
  } else {
    return null;
  }

  const col = table.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
  if (!col || col.type !== "INT") return null; // index keys are 64-bit ints
  const index = catalog.findIndex(table.name, column);
  if (!index) return null;

  switch (op) {
    case "=":
      return { column: col.name, root: index.root, lo: value, hi: value };
    case ">":
      return { column: col.name, root: index.root, lo: value + 1n, hi: I64_MAX };
    case ">=":
      return { column: col.name, root: index.root, lo: value, hi: I64_MAX };
    case "<":
      return { column: col.name, root: index.root, lo: I64_MIN, hi: value - 1n };
    case "<=":
      return { column: col.name, root: index.root, lo: I64_MIN, hi: value };
    case "!=":
      return null; // not a contiguous range
  }
}
