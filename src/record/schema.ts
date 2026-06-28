import {
  TYPE_BLOB,
  TYPE_BOOL,
  TYPE_DATETIME,
  TYPE_INT,
  TYPE_REAL,
  TYPE_TEXT,
} from "../constants.js";
import { TupleError } from "../errors.js";

/**
 * The column types the engine understands and their runtime representations:
 *   INT      → signed 64-bit `bigint`
 *   REAL     → `number` (IEEE-754 double)
 *   TEXT     → `string`
 *   BOOL     → `boolean`
 *   BLOB     → `Buffer` (raw bytes)
 *   DATETIME → `Date` (stored as signed 64-bit epoch milliseconds)
 */
export type ColumnType = "INT" | "REAL" | "TEXT" | "BOOL" | "BLOB" | "DATETIME";

export interface Column {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
}

/** An ordered list of columns describing a row's shape. */
export interface Schema {
  readonly columns: readonly Column[];
}

/** A single column value. NULL is represented by `null`. */
export type Value = bigint | number | string | boolean | Buffer | Date | null;

/** A row as a positional tuple aligned to a schema's column order. */
export type Row = Value[];

export function makeSchema(columns: readonly Column[]): Schema {
  const seen = new Set<string>();
  for (const c of columns) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) throw new TupleError(`duplicate column "${c.name}"`);
    seen.add(key);
  }
  return { columns };
}

export function columnIndex(schema: Schema, name: string): number {
  const idx = schema.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  if (idx < 0) throw new TupleError(`no such column "${name}"`);
  return idx;
}

export function typeTag(type: ColumnType): number {
  switch (type) {
    case "INT":
      return TYPE_INT;
    case "REAL":
      return TYPE_REAL;
    case "TEXT":
      return TYPE_TEXT;
    case "BOOL":
      return TYPE_BOOL;
    case "BLOB":
      return TYPE_BLOB;
    case "DATETIME":
      return TYPE_DATETIME;
  }
}

export function typeFromTag(tag: number): ColumnType {
  switch (tag) {
    case TYPE_INT:
      return "INT";
    case TYPE_REAL:
      return "REAL";
    case TYPE_TEXT:
      return "TEXT";
    case TYPE_BOOL:
      return "BOOL";
    case TYPE_BLOB:
      return "BLOB";
    case TYPE_DATETIME:
      return "DATETIME";
    default:
      throw new TupleError(`unknown column type tag ${tag}`);
  }
}
