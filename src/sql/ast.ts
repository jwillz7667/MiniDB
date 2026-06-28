import type { ColumnType } from "../record/schema.js";

/**
 * A constant value that can appear in SQL: an integer (`bigint`), a REAL
 * (`number`), a string, a boolean, a blob literal (`Buffer`, via `X'..'`), a
 * `Date` (only through a bound parameter), or NULL.
 */
export type LiteralValue = bigint | number | string | boolean | Buffer | Date | null;

export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=";
export type LogicalOp = "AND" | "OR";
export type SortDir = "ASC" | "DESC";

/** WHERE-clause expression tree. */
export type Expr = LiteralExpr | ParamExpr | ColumnExpr | CompareExpr | LogicalExpr;

export interface LiteralExpr {
  readonly kind: "literal";
  readonly value: LiteralValue;
}

/**
 * A positional bind placeholder (`?`). Produced by the parser and resolved to a
 * LiteralExpr by `bindStatement` before planning — no param node ever reaches
 * the optimizer or executor.
 */
export interface ParamExpr {
  readonly kind: "param";
  readonly index: number;
}

/** A value position that may be a literal or a placeholder (INSERT/UPDATE). */
export type ValueExpr = LiteralExpr | ParamExpr;

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
  | UpdateStmt
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
  /** One entry per value; literals or `?` placeholders (resolved by binding). */
  readonly rows: ValueExpr[][];
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

/** A single `col = <value>` assignment in an UPDATE. */
export interface Assignment {
  readonly column: string;
  /** Evaluated against the existing row; a literal, `?` placeholder, or column. */
  readonly value: Expr;
}

export interface UpdateStmt {
  readonly kind: "update";
  readonly table: string;
  readonly assignments: Assignment[];
  readonly where: Expr | null;
}

export interface ExplainStmt {
  readonly kind: "explain";
  readonly statement: SelectStmt | InsertStmt | UpdateStmt | DeleteStmt;
}

export interface TxnStmt {
  readonly kind: "begin" | "commit" | "rollback";
}
