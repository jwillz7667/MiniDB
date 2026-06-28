import { PlanError } from "../errors.js";
import type { Catalog } from "../record/catalog.js";
import { type Column, columnIndex, type Value } from "../record/schema.js";
import { BTree } from "../storage/btree.js";
import type {
  CreateIndexStmt,
  CreateTableStmt,
  DeleteStmt,
  ExplainStmt,
  InsertStmt,
  SelectStmt,
  Statement,
  UpdateStmt,
} from "../sql/ast.js";
import {
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  type LogicalPlan,
} from "../plan/logical.js";
import { optimize } from "../plan/optimizer.js";
import { explain, toPhysical } from "../plan/physical.js";
import type { ExecContext } from "./context.js";
import { buildOperator, type ExecTuple, type Operator } from "./operators.js";

export type QueryResult =
  | { readonly type: "select"; readonly columns: string[]; readonly rows: Value[][] }
  | {
      readonly type: "insert";
      readonly rowCount: number;
      /** Internal rowid of the last row inserted, or null if none were. */
      readonly lastInsertRowid: bigint | null;
    }
  | { readonly type: "update"; readonly rowCount: number }
  | { readonly type: "delete"; readonly rowCount: number }
  | { readonly type: "createTable"; readonly table: string }
  | { readonly type: "createIndex"; readonly table: string; readonly column: string }
  | { readonly type: "explain"; readonly lines: string[] };

/**
 * Turns a parsed statement into a result by running the planner pipeline
 * (logical → optimize → physical → operators) and driving the operator tree.
 * Transaction control (BEGIN/COMMIT/ROLLBACK) is handled one level up, by the
 * Database facade, since it spans statements.
 */
export class Executor {
  constructor(
    private readonly ctx: ExecContext,
    private readonly catalog: Catalog,
  ) {}

  run(stmt: Statement): QueryResult {
    switch (stmt.kind) {
      case "createTable":
        return this.createTable(stmt);
      case "createIndex":
        return this.createIndex(stmt);
      case "select":
        return this.select(stmt);
      case "insert":
        return this.insert(stmt);
      case "update":
        return this.update(stmt);
      case "delete":
        return this.delete(stmt);
      case "explain":
        return this.explainStmt(stmt);
      default:
        throw new PlanError(`statement "${stmt.kind}" is not executed here`);
    }
  }

  private createTable(stmt: CreateTableStmt): QueryResult {
    const columns: Column[] = stmt.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      primaryKey: c.primaryKey,
      unique: c.unique,
      autoIncrement: c.autoIncrement,
      ...(c.default !== undefined ? { default: c.default } : {}),
    }));
    this.catalog.createTable(this.ctx.tx, stmt.table, columns);
    return { type: "createTable", table: stmt.table };
  }

  private createIndex(stmt: CreateIndexStmt): QueryResult {
    const table = this.catalog.requireTable(stmt.table);
    const col = table.columns.find((c) => c.name.toLowerCase() === stmt.column.toLowerCase());
    if (!col) throw new PlanError(`column "${stmt.column}" does not exist on "${stmt.table}"`);
    if (col.type !== "INT") {
      throw new PlanError(`indexes are only supported on INT columns (got ${col.type})`);
    }

    const root = BTree.create(this.ctx.tx);
    const colIdx = columnIndex(table.schema, col.name);
    for (const row of this.ctx.store.scan(this.ctx.tx, table)) {
      const key = row.values[colIdx]!;
      if (key !== null) BTree.insert(this.ctx.tx, root, key as bigint, row.rid);
    }
    this.catalog.createIndex(this.ctx.tx, table.name, col.name, root);
    return { type: "createIndex", table: table.name, column: col.name };
  }

  private select(stmt: SelectStmt): QueryResult {
    const plan = toPhysical(optimize(buildSelect(stmt, this.catalog), this.catalog));
    const columns = plan.columns.map((c) => c.name);
    const rows = this.drain(buildOperator(plan, this.ctx)).map((t) => t.values);
    return { type: "select", columns, rows };
  }

  private insert(stmt: InsertStmt): QueryResult {
    const plan = toPhysical(buildInsert(stmt, this.catalog));
    const inserted = this.drainTuples(buildOperator(plan, this.ctx));
    const last = inserted.at(-1);
    return {
      type: "insert",
      rowCount: inserted.length,
      lastInsertRowid: last ? last.rowid : null,
    };
  }

  private update(stmt: UpdateStmt): QueryResult {
    const plan = toPhysical(optimize(buildUpdate(stmt, this.catalog), this.catalog));
    return { type: "update", rowCount: this.drain(buildOperator(plan, this.ctx)).length };
  }

  private delete(stmt: DeleteStmt): QueryResult {
    const plan = toPhysical(optimize(buildDelete(stmt, this.catalog), this.catalog));
    return { type: "delete", rowCount: this.drain(buildOperator(plan, this.ctx)).length };
  }

  private explainStmt(stmt: ExplainStmt): QueryResult {
    const inner = stmt.statement;
    let logical: LogicalPlan;
    if (inner.kind === "select") logical = buildSelect(inner, this.catalog);
    else if (inner.kind === "insert") logical = buildInsert(inner, this.catalog);
    else if (inner.kind === "update") logical = buildUpdate(inner, this.catalog);
    else logical = buildDelete(inner, this.catalog);
    return { type: "explain", lines: explain(toPhysical(optimize(logical, this.catalog))) };
  }

  /** Pull an operator to exhaustion, collecting its tuples. */
  private drain(op: Operator): { values: Value[] }[] {
    return this.drainTuples(op);
  }

  /** Like `drain`, but preserves the full tuple (rowid/rid) for callers that need it. */
  private drainTuples(op: Operator): ExecTuple[] {
    const out: ExecTuple[] = [];
    op.open();
    try {
      for (let t = op.next(); t !== null; t = op.next()) out.push(t);
    } finally {
      op.close();
    }
    return out;
  }
}
