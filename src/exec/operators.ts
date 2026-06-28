import type { TableMeta } from "../record/catalog.js";
import type { Column, Value } from "../record/schema.js";
import { sortCompare } from "../record/value.js";
import { BTree } from "../storage/btree.js";
import type { Rid } from "../storage/rid.js";
import type { Expr } from "../sql/ast.js";
import type { PhysicalPlan } from "../plan/physical.js";
import type { ExecContext } from "./context.js";
import { compilePredicate } from "./eval.js";
import type { ScannedRow } from "./table-store.js";

/** A tuple flowing through the operator pipeline. */
export interface ExecTuple {
  readonly rowid: bigint;
  readonly rid: Rid;
  readonly values: Value[];
}

/** The Volcano iterator interface: every operator pulls rows one at a time. */
export interface Operator {
  readonly columns: Column[];
  open(): void;
  next(): ExecTuple | null;
  close(): void;
}

/** Walk every live row in a table's heap. */
class SeqScanOp implements Operator {
  readonly columns: Column[];
  private iter: Generator<ScannedRow> | null = null;

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
  ) {
    this.columns = table.columns;
  }

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
  readonly columns: Column[];
  private gen: Generator<[bigint, Rid]> | null = null;

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    private readonly root: number,
    private readonly lo: bigint,
    private readonly hi: bigint,
  ) {
    this.columns = table.columns;
  }

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

/** Drop rows that fail the predicate. */
class FilterOp implements Operator {
  readonly columns: Column[];
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
    readonly columns: Column[],
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

/** Buffer the child fully, then emit rows in sorted order (in-memory sort). */
class SortOp implements Operator {
  readonly columns: Column[];
  private buffer: ExecTuple[] = [];
  private pos = 0;

  constructor(
    private readonly child: Operator,
    private readonly sortIndex: number,
    private readonly dir: "ASC" | "DESC",
  ) {
    this.columns = child.columns;
  }

  open(): void {
    this.child.open();
    this.buffer = [];
    for (let t = this.child.next(); t !== null; t = this.child.next()) this.buffer.push(t);
    const sign = this.dir === "DESC" ? -1 : 1;
    this.buffer.sort(
      (a, b) => sign * sortCompare(a.values[this.sortIndex]!, b.values[this.sortIndex]!),
    );
    this.pos = 0;
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
  readonly columns: Column[];
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
  readonly columns: Column[];
  private pos = 0;

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    private readonly rows: Value[][],
  ) {
    this.columns = table.columns;
  }

  open(): void {
    this.pos = 0;
  }

  next(): ExecTuple | null {
    if (this.pos >= this.rows.length) return null;
    const values = this.rows[this.pos++]!;
    const rowid = this.ctx.rowids.allocate(this.ctx.tx, this.table);
    const rid = this.ctx.store.insertRow(this.ctx.tx, this.table, rowid, values);
    return { rowid, rid, values };
  }

  close(): void {
    /* nothing to release */
  }
}

/** Delete each row pulled from the child; emits the deleted tuples. */
class DeleteOp implements Operator {
  readonly columns: Column[];

  constructor(
    private readonly ctx: ExecContext,
    private readonly table: TableMeta,
    private readonly child: Operator,
  ) {
    this.columns = table.columns;
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
      return new SeqScanOp(ctx, plan.table);
    case "IndexScan":
      return new IndexScanOp(ctx, plan.table, plan.root, plan.lo, plan.hi);
    case "Filter":
      return new FilterOp(buildOperator(plan.input, ctx), plan.predicate);
    case "Project":
      return new ProjectOp(buildOperator(plan.input, ctx), plan.columns, plan.indices);
    case "Sort":
      return new SortOp(buildOperator(plan.input, ctx), plan.sortIndex, plan.dir);
    case "Limit":
      return new LimitOp(buildOperator(plan.input, ctx), plan.limit);
    case "Insert":
      return new InsertOp(ctx, plan.table, plan.rows);
    case "Delete":
      return new DeleteOp(ctx, plan.table, buildOperator(plan.input, ctx));
  }
}
