import type { TableMeta } from "./record/catalog.js";
import type { Column } from "./record/schema.js";
import { valueToLiteral } from "./record/value.js";

/**
 * Reconstruct the SQL that would recreate a table or index from catalog
 * metadata. Used by VACUUM (rebuild into a fresh file) and by schema dumps.
 * Identifiers are simple (the lexer only accepts `[A-Za-z_][A-Za-z0-9_]*`), so
 * no quoting is required.
 */

function columnDDL(c: Column): string {
  const parts: string[] = [c.name, c.type];
  if (c.primaryKey) parts.push("PRIMARY KEY");
  else if (!c.nullable) parts.push("NOT NULL");
  if (c.autoIncrement) parts.push("AUTOINCREMENT");
  if (c.unique && !c.primaryKey) parts.push("UNIQUE");
  if (c.default !== undefined) parts.push(`DEFAULT ${valueToLiteral(c.default)}`);
  return parts.join(" ");
}

export function reconstructCreateTable(table: TableMeta): string {
  return `CREATE TABLE ${table.name} (${table.columns.map(columnDDL).join(", ")})`;
}

export function reconstructCreateIndex(tableName: string, columnName: string): string {
  return `CREATE INDEX ON ${tableName} (${columnName})`;
}
