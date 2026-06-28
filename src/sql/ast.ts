import type { ColumnType } from "../record/schema.js";

/** A constant value that can appear in SQL. */
export type LiteralValue = bigint | string | boolean | null;

export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=";
export type LogicalOp = "AND" | "OR";
export type SortDir = "ASC" | "DESC";

/** WHERE-clause expression tree. */
export type Expr = LiteralExpr | ColumnExpr | CompareExpr | LogicalExpr;

export interface LiteralExpr {
  readonly kind: "literal";
  readonly value: LiteralValue;
}

export interface ColumnExpr {
  readonly kind: "column";
  readonly name: string;
}

export interface CompareExpr {
  readonly kind: "compare";
  readonly op: CompareOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface LogicalExpr {
  readonly kind: "logical";
  readonly op: LogicalOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface ColumnDef {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
}

/** Top-level statements. */
export type Statement =
  | CreateTableStmt
  | CreateIndexStmt
  | InsertStmt
  | SelectStmt
  | DeleteStmt
  | ExplainStmt
  | TxnStmt;

export interface CreateTableStmt {
  readonly kind: "createTable";
  readonly table: string;
  readonly columns: ColumnDef[];
}

export interface CreateIndexStmt {
  readonly kind: "createIndex";
  readonly table: string;
  readonly column: string;
}

export interface InsertStmt {
  readonly kind: "insert";
  readonly table: string;
  /** Target columns, or null to mean "all columns in declared order". */
  readonly columns: string[] | null;
  readonly rows: LiteralValue[][];
}

export interface OrderBy {
  readonly column: string;
  readonly dir: SortDir;
}

export interface SelectStmt {
  readonly kind: "select";
  /** Projected column names, or "*" for all. */
  readonly columns: string[] | "*";
  readonly table: string;
  readonly where: Expr | null;
  readonly orderBy: OrderBy | null;
  readonly limit: number | null;
}

export interface DeleteStmt {
  readonly kind: "delete";
  readonly table: string;
  readonly where: Expr | null;
}

export interface ExplainStmt {
  readonly kind: "explain";
  readonly statement: SelectStmt | InsertStmt | DeleteStmt;
}

export interface TxnStmt {
  readonly kind: "begin" | "commit" | "rollback";
}
