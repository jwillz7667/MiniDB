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
export type Expr = LiteralExpr | ParamExpr | ColumnExpr | CallExpr | CompareExpr | LogicalExpr;

/** An aggregate function call: `COUNT(*)`, `SUM(total)`, `MIN(x)`, etc. */
export interface CallExpr {
  readonly kind: "call";
  /** Lowercased function name (count, sum, avg, min, max). */
  readonly func: string;
  /** True for `COUNT(*)`; then `arg` is null. */
  readonly star: boolean;
  readonly arg: Expr | null;
}

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
  /** Optional table/alias qualifier, e.g. the `u` in `u.id`. */
  readonly table: string | null;
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
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly autoIncrement: boolean;
  /** DEFAULT literal value, or undefined if none was declared. */
  readonly default: LiteralValue | undefined;
}

/** Top-level statements. */
export type Statement =
  | CreateTableStmt
  | CreateIndexStmt
  | DropTableStmt
  | DropIndexStmt
  | AlterTableStmt
  | InsertStmt
  | SelectStmt
  | UpdateStmt
  | DeleteStmt
  | ExplainStmt
  | VacuumStmt
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

export interface DropTableStmt {
  readonly kind: "dropTable";
  readonly table: string;
  readonly ifExists: boolean;
}

export interface DropIndexStmt {
  readonly kind: "dropIndex";
  readonly table: string;
  readonly column: string;
}

export interface AlterTableStmt {
  readonly kind: "alterTable";
  readonly table: string;
  /** The column to add (ALTER TABLE … ADD COLUMN). */
  readonly column: ColumnDef;
}

export interface InsertStmt {
  readonly kind: "insert";
  readonly table: string;
  /** Target columns, or null to mean "all columns in declared order". */
  readonly columns: string[] | null;
  /** One entry per value; literals or `?` placeholders (resolved by binding). */
  readonly rows: ValueExpr[][];
}

/** A (possibly qualified) column reference: the `u.id` or `id` in a clause. */
export interface ColumnRef {
  readonly table: string | null;
  readonly name: string;
}

export interface OrderBy {
  readonly column: ColumnRef;
  readonly dir: SortDir;
}

/** A table in the FROM clause with an optional alias (`users u` / `users AS u`). */
export interface TableRef {
  readonly table: string;
  readonly alias: string | null;
}

export type JoinType = "inner" | "left";

export interface JoinClause {
  readonly type: JoinType;
  readonly right: TableRef;
  readonly on: Expr;
}

export interface FromClause {
  readonly base: TableRef;
  readonly joins: JoinClause[];
}

/** A SELECT-list entry: an expression (column or aggregate) with optional alias. */
export interface SelectItem {
  readonly expr: Expr;
  readonly alias: string | null;
}

export interface SelectStmt {
  readonly kind: "select";
  /** Projected items, or "*" for every column of every FROM table. */
  readonly columns: SelectItem[] | "*";
  readonly from: FromClause;
  readonly where: Expr | null;
  readonly groupBy: ColumnRef[] | null;
  readonly having: Expr | null;
  readonly orderBy: OrderBy | null;
  /** LIMIT count: an integer literal or a `?` placeholder (resolved at bind). */
  readonly limit: ValueExpr | null;
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

/** Rebuild the database file, reclaiming dead space. */
export interface VacuumStmt {
  readonly kind: "vacuum";
}

export interface TxnStmt {
  readonly kind: "begin" | "commit" | "rollback";
}
