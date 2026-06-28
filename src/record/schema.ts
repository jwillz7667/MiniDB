import { TYPE_BOOL, TYPE_INT, TYPE_TEXT } from "../constants.js";
import { TupleError } from "../errors.js";

/** The column types the engine understands. INT is a signed 64-bit `bigint`. */
export type ColumnType = "INT" | "TEXT" | "BOOL";

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
export type Value = bigint | string | boolean | null;

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
    case "TEXT":
      return TYPE_TEXT;
    case "BOOL":
      return TYPE_BOOL;
  }
}

export function typeFromTag(tag: number): ColumnType {
  switch (tag) {
    case TYPE_INT:
      return "INT";
    case TYPE_TEXT:
      return "TEXT";
    case TYPE_BOOL:
      return "BOOL";
    default:
      throw new TupleError(`unknown column type tag ${tag}`);
  }
}
