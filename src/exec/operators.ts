import { ExecutionError } from "../errors.js";
import type { TableMeta } from "../record/catalog.js";
import type { Value } from "../record/schema.js";
import { sortCompare } from "../record/value.js";
import { BTree } from "../storage/btree.js";
import type { Rid } from "../storage/rid.js";
import type { Expr, JoinType } from "../sql/ast.js";
import type { ResolvedAssignment } from "../plan/logical.js";
import type { PhysicalPlan, PlanColumn } from "../plan/physical.js";
import type { ExecContext } from "./context.js";
import { type CompiledExpr, compileExpr, compilePredicate } from "./eval.js";
import type { ScannedRow } from "./table-store.js";

/** A tuple flowing through the operator pipeline. */
export interface ExecTuple {
  readonly rowid: bigint;
  readonly rid: Rid;
  readonly values: Value[];
}

/** The Volcano iterator interface: every operator pulls rows one at a time. */
export interface Operator {
  readonly columns: PlanColumn[];
  open(): void;
  next(): ExecTuple | null;
  close(): void;
}

const nulls = (n: number): Value[] => new Array<Value>(n).fill(null);

/** Walk every live row in a table's heap. */
class SeqScanOp implements Operator {
  private iter: Generator<ScannedRow> | null = null;

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    readonly columns: PlanColumn[],
  ) {}

  open(): void {
    this.iter = this.ctx.store.scan(this.ctx.tx, this.table);
  }

  next(): ExecTuple | null {
    const r = this.iter!.next();
    return r.done ? null : r.value;
  }

  close(): void {
    this.iter = null;
  }
}

/** Use a B+Tree to fetch only the rids in a key range, then load those rows. */
class IndexScanOp implements Operator {
  private gen: Generator<[bigint, Rid]> | null = null;

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    readonly columns: PlanColumn[],
    private readonly root: number,
    private readonly lo: bigint,
    private readonly hi: bigint,
  ) {}

  open(): void {
    this.gen = BTree.rangeScan(this.ctx.tx, this.root, this.lo, this.hi);
  }

  next(): ExecTuple | null {
    const r = this.gen!.next();
    if (r.done) return null;
    const [, rid] = r.value;
    return this.ctx.store.getRow(this.ctx.tx, this.table, rid);
  }

  close(): void {
    this.gen = null;
  }
}

/** Combine two inputs by re-scanning the right input for every left row. */
class NestedLoopJoinOp implements Operator {
  private readonly test: (values: Value[]) => boolean;
  private currentLeft: ExecTuple | null = null;
  private rightOpen = false;
  private matched = false;

  constructor(
    private readonly left: Operator,
    private readonly right: Operator,
    readonly columns: PlanColumn[],
    private readonly joinType: JoinType,
    on: Expr,
    private readonly rightWidth: number,
  ) {
    this.test = compilePredicate(on, columns);
  }

  open(): void {
    this.left.open();
    this.currentLeft = null;
    this.rightOpen = false;
    this.matched = false;
  }

  next(): ExecTuple | null {
    for (;;) {
      if (this.currentLeft === null) {
        this.currentLeft = this.left.next();
        if (this.currentLeft === null) return null;
        this.right.open();
        this.rightOpen = true;
        this.matched = false;
      }
      const r = this.right.next();
      if (r !== null) {
        const values = [...this.currentLeft.values, ...r.values];
        if (this.test(values)) {
          this.matched = true;
          return { rowid: this.currentLeft.rowid, rid: this.currentLeft.rid, values };
        }
        continue;
      }
      this.right.close();
      this.rightOpen = false;
      const left = this.currentLeft;
      this.currentLeft = null;
      if (this.joinType === "left" && !this.matched) {
        return { rowid: left.rowid, rid: left.rid, values: [...left.values, ...nulls(this.rightWidth)] };
      }
    }
  }

  close(): void {
    if (this.rightOpen) this.right.close();
    this.left.close();
  }
}

/** A normalized hash key for an equi-join (numeric INT/REAL share a key). */
function joinKey(v: Exclude<Value, null>): string {
  if (typeof v === "bigint" || typeof v === "number") return `n${String(v)}`;
  if (typeof v === "string") return `s${v}`;
  if (typeof v === "boolean") return `b${v ? 1 : 0}`;
  if (v instanceof Date) return `t${v.getTime()}`;
  return `x${Buffer.from(v as Uint8Array).toString("hex")}`;
}

/** Equi-join: hash the right input on its key, then probe with each left row. */
class HashJoinOp implements Operator {
  private buckets = new Map<string, ExecTuple[]>();
  private leftRow: ExecTuple | null = null;
  private bucket: ExecTuple[] = [];
  private bucketPos = 0;
  private matchedCurrent = false;

  constructor(
    private readonly left: Operator,
    private readonly right: Operator,
    readonly columns: PlanColumn[],
    private readonly joinType: JoinType,
    private readonly leftKeyIndex: number,
    private readonly rightKeyIndex: number,
    private readonly rightWidth: number,
  ) {}

  open(): void {
    this.left.open();
    this.buckets = new Map();
    this.right.open();
    try {
      for (let r = this.right.next(); r !== null; r = this.right.next()) {
        const k = r.values[this.rightKeyIndex]!;
        if (k === null) continue; // NULL keys never join
        const key = joinKey(k);
        const arr = this.buckets.get(key);
        if (arr) arr.push(r);
        else this.buckets.set(key, [r]);
      }
    } finally {
      this.right.close();
    }
    this.leftRow = null;
    this.bucket = [];
    this.bucketPos = 0;
  }

  next(): ExecTuple | null {
    for (;;) {
      if (this.bucketPos < this.bucket.length) {
        this.matchedCurrent = true;
        const r = this.bucket[this.bucketPos++]!;
        return { rowid: this.leftRow!.rowid, rid: this.leftRow!.rid, values: [...this.leftRow!.values, ...r.values] };
      }
      if (this.leftRow !== null && this.joinType === "left" && !this.matchedCurrent) {
        const left = this.leftRow;
        this.leftRow = null;
        return { rowid: left.rowid, rid: left.rid, values: [...left.values, ...nulls(this.rightWidth)] };
      }
      this.leftRow = this.left.next();
      if (this.leftRow === null) return null;
      this.matchedCurrent = false;
      const k = this.leftRow.values[this.leftKeyIndex]!;
      this.bucket = k === null ? [] : (this.buckets.get(joinKey(k)) ?? []);
      this.bucketPos = 0;
    }
  }

  close(): void {
    this.left.close();
    this.buckets.clear();
  }
}

/** Drop rows that fail the predicate. */
class FilterOp implements Operator {
  readonly columns: PlanColumn[];
  private readonly test: (values: Value[]) => boolean;

  constructor(
    private readonly child: Operator,
    predicate: Expr,
  ) {
    this.columns = child.columns;
    this.test = compilePredicate(predicate, child.columns);
  }

  open(): void {
    this.child.open();
  }

  next(): ExecTuple | null {
    for (;;) {
      const t = this.child.next();
      if (t === null) return null;
      if (this.test(t.values)) return t;
    }
  }

  close(): void {
    this.child.close();
  }
}

/** Select and reorder columns. */
class ProjectOp implements Operator {
  constructor(
    private readonly child: Operator,
    readonly columns: PlanColumn[],
    private readonly indices: number[],
  ) {}

  open(): void {
    this.child.open();
  }

  next(): ExecTuple | null {
    const t = this.child.next();
    if (t === null) return null;
    return { rowid: t.rowid, rid: t.rid, values: this.indices.map((i) => t.values[i]!) };
  }

  close(): void {
    this.child.close();
  }
}

/**
 * Sort the child's rows in memory. When an enclosing LIMIT is known, only the
 * top-N rows are retained (bounded memory); otherwise the full result is
 * buffered, but capped at `maxRows` so a runaway ORDER BY fails safe instead of
 * exhausting memory.
 */
class SortOp implements Operator {
  readonly columns: PlanColumn[];
  private buffer: ExecTuple[] = [];
  private pos = 0;

  constructor(
    private readonly child: Operator,
    private readonly sortIndex: number,
    private readonly dir: "ASC" | "DESC",
    private readonly limit: number | undefined,
    private readonly maxRows: number,
  ) {
    this.columns = child.columns;
  }

  private cmp(a: ExecTuple, b: ExecTuple): number {
    const sign = this.dir === "DESC" ? -1 : 1;
    return sign * sortCompare(a.values[this.sortIndex]!, b.values[this.sortIndex]!);
  }

  open(): void {
    this.child.open();
    this.pos = 0;
    this.buffer = this.limit !== undefined ? this.topN(this.limit) : this.bufferAll();
  }

  /** Keep a sorted array of at most `n` rows, dropping the worst on overflow. */
  private topN(n: number): ExecTuple[] {
    const kept: ExecTuple[] = [];
    for (let t = this.child.next(); t !== null; t = this.child.next()) {
      if (n === 0) continue;
      if (kept.length < n) {
        if (kept.length >= this.maxRows) {
          throw new ExecutionError(
            `ORDER BY buffered more than ${this.maxRows} rows; lower the LIMIT or add a tighter WHERE`,
          );
        }
        this.insertSorted(kept, t);
      } else if (this.cmp(t, kept[kept.length - 1]!) < 0) {
        kept.pop();
        this.insertSorted(kept, t);
      }
    }
    return kept;
  }

  private insertSorted(arr: ExecTuple[], t: ExecTuple): void {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cmp(arr[mid]!, t) <= 0) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, t);
  }

  private bufferAll(): ExecTuple[] {
    const buf: ExecTuple[] = [];
    for (let t = this.child.next(); t !== null; t = this.child.next()) {
      buf.push(t);
      if (buf.length > this.maxRows) {
        throw new ExecutionError(
          `ORDER BY buffered more than ${this.maxRows} rows; add a LIMIT or a tighter WHERE`,
        );
      }
    }
    buf.sort((a, b) => this.cmp(a, b));
    return buf;
  }

  next(): ExecTuple | null {
    return this.pos < this.buffer.length ? this.buffer[this.pos++]! : null;
  }

  close(): void {
    this.child.close();
    this.buffer = [];
  }
}

/** Stop after N rows. */
class LimitOp implements Operator {
  readonly columns: PlanColumn[];
  private produced = 0;

  constructor(
    private readonly child: Operator,
    private readonly limit: number,
  ) {
    this.columns = child.columns;
  }

  open(): void {
    this.child.open();
    this.produced = 0;
  }

  next(): ExecTuple | null {
    if (this.produced >= this.limit) return null;
    const t = this.child.next();
    if (t === null) return null;
    this.produced += 1;
    return t;
  }

  close(): void {
    this.child.close();
  }
}

/** Write rows into the heap and all indexes; emits each inserted tuple. */
class InsertOp implements Operator {
  private pos = 0;

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    readonly columns: PlanColumn[],
    private readonly rows: Value[][],
    private readonly autoIncrement: { columnIndex: number; indexRoot: number } | undefined,
  ) {}

  open(): void {
    this.pos = 0;
  }

  next(): ExecTuple | null {
    if (this.pos >= this.rows.length) return null;
    let values = this.rows[this.pos++]!;
    if (this.autoIncrement) {
      const { columnIndex, indexRoot } = this.autoIncrement;
      if (values[columnIndex] === null) {
        // Next id = current max in the column's unique index + 1. Reading the
        // index each time reflects rows inserted earlier in this same statement.
        values = values.slice();
        values[columnIndex] = (BTree.maxKey(this.ctx.tx, indexRoot) ?? 0n) + 1n;
      }
    }
    const rowid = this.ctx.rowids.allocate(this.ctx.tx, this.table);
    const rid = this.ctx.store.insertRow(this.ctx.tx, this.table, rowid, values);
    return { rowid, rid, values };
  }

  close(): void {
    /* nothing to release */
  }
}

/**
 * Apply SET assignments to each row matched by the child. The full target set is
 * materialized before any write so an UPDATE that relocates rows (or changes an
 * indexed key driving the scan) never re-processes a row it just wrote — the
 * Halloween problem. Each new value is computed against the row's OLD values.
 */
class UpdateOp implements Operator {
  readonly columns: PlanColumn[];
  private readonly setters: { readonly index: number; readonly compute: CompiledExpr }[];
  private pending: ExecTuple[] = [];
  private pos = 0;

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    private readonly child: Operator,
    assignments: ResolvedAssignment[],
  ) {
    this.columns = child.columns;
    this.setters = assignments.map((a) => ({
      index: a.index,
      compute: compileExpr(a.value, child.columns),
    }));
  }

  open(): void {
    this.child.open();
    this.pending = [];
    try {
      for (let t = this.child.next(); t !== null; t = this.child.next()) this.pending.push(t);
    } finally {
      this.child.close();
    }
    this.pos = 0;
  }

  next(): ExecTuple | null {
    if (this.pos >= this.pending.length) return null;
    const row = this.pending[this.pos++]!;
    const newValues = row.values.slice();
    for (const s of this.setters) newValues[s.index] = s.compute(row.values);
    const newRid = this.ctx.store.updateRow(this.ctx.tx, this.table, row, newValues);
    return { rowid: row.rowid, rid: newRid, values: newValues };
  }

  close(): void {
    this.pending = [];
  }
}

/** Delete each row pulled from the child; emits the deleted tuples. */
class DeleteOp implements Operator {
  readonly columns: PlanColumn[];

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    private readonly child: Operator,
  ) {
    this.columns = child.columns;
  }

  open(): void {
    this.child.open();
  }

  next(): ExecTuple | null {
    const t = this.child.next();
    if (t === null) return null;
    this.ctx.store.deleteRow(this.ctx.tx, this.table, t);
    return t;
  }

  close(): void {
    this.child.close();
  }
}

/** Instantiate the operator tree for a physical plan. */
export function buildOperator(plan: PhysicalPlan, ctx: ExecContext): Operator {
  switch (plan.op) {
    case "SeqScan":
      return new SeqScanOp(ctx, plan.table, plan.columns);
    case "IndexScan":
      return new IndexScanOp(ctx, plan.table, plan.columns, plan.root, plan.lo, plan.hi);
    case "NestedLoopJoin":
      return new NestedLoopJoinOp(
        buildOperator(plan.left, ctx),
        buildOperator(plan.right, ctx),
        plan.columns,
        plan.joinType,
        plan.on,
        plan.columns.length - plan.leftWidth,
      );
    case "HashJoin":
      return new HashJoinOp(
        buildOperator(plan.left, ctx),
        buildOperator(plan.right, ctx),
        plan.columns,
        plan.joinType,
        plan.leftKeyIndex!,
        plan.rightKeyIndex!,
        plan.columns.length - plan.leftWidth,
      );
    case "Filter":
      return new FilterOp(buildOperator(plan.input, ctx), plan.predicate);
    case "Project":
      return new ProjectOp(buildOperator(plan.input, ctx), plan.columns, plan.indices);
    case "Sort":
      return new SortOp(
        buildOperator(plan.input, ctx),
        plan.sortIndex,
        plan.dir,
        plan.limit,
        ctx.maxSortRows,
      );
    case "Limit":
      return new LimitOp(buildOperator(plan.input, ctx), plan.limit);
    case "Insert":
      return new InsertOp(ctx, plan.table, plan.columns, plan.rows, plan.autoIncrement);
    case "Update":
      return new UpdateOp(ctx, plan.table, buildOperator(plan.input, ctx), plan.assignments);
    case "Delete":
      return new DeleteOp(ctx, plan.table, buildOperator(plan.input, ctx));
  }
}
