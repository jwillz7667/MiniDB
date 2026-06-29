import {
  type ColumnMetadata,
  CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  type SchemaMetadata,
  SqliteAdapter,
  SqliteQueryCompiler,
  type TableMetadata,
} from "kysely";

import { Database } from "../db.js";
import type { ColumnType } from "../record/schema.js";
import type { BindValue } from "../sql/bind.js";

export interface MinidbDialectConfig {
  /** An already-open minidb database (its lifecycle is yours, not Kysely's). */
  readonly database: Database;
}

/**
 * A Kysely dialect for minidb, so the engine works with the popular type-safe
 * query builder. It reuses Kysely's SQLite SQL compiler (minidb speaks the same
 * `?`-placeholder, double-quoted-identifier dialect) and bridges Kysely's async
 * driver interface to minidb's synchronous API. The supported SQL is whatever
 * minidb implements (no subqueries/CTEs/RETURNING/OFFSET yet).
 */
export class MinidbDialect implements Dialect {
  constructor(private readonly config: MinidbDialectConfig) {}

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new MinidbDriver(this.config.database);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(_db: Kysely<unknown>): DatabaseIntrospector {
    return new MinidbIntrospector(this.config.database);
  }
}

class MinidbDriver implements Driver {
  private readonly connection: MinidbConnection;

  constructor(db: Database) {
    this.connection = new MinidbConnection(db);
  }

  async init(): Promise<void> {
    /* nothing to set up */
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    // minidb is single-writer, so one logical connection serves everything.
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(compiled("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(compiled("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(compiled("ROLLBACK"));
  }

  async releaseConnection(): Promise<void> {
    /* the single connection is reused */
  }

  async destroy(): Promise<void> {
    /* the caller owns the Database lifecycle */
  }
}

class MinidbConnection implements DatabaseConnection {
  constructor(private readonly db: Database) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const params = compiledQuery.parameters.map(toBindValue);
    const result = this.db.exec(compiledQuery.sql, params);
    switch (result.type) {
      case "select":
        return { rows: result.rows.map((row) => toObject(result.columns, row)) as R[] };
      case "insert":
        return {
          rows: [],
          numAffectedRows: BigInt(result.rowCount),
          ...(result.lastInsertRowid !== null ? { insertId: result.lastInsertRowid } : {}),
        };
      case "update":
      case "delete":
        return { rows: [], numAffectedRows: BigInt(result.rowCount) };
      default:
        return { rows: [] };
    }
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("minidb does not support streaming queries");
  }
}

/** Minimal schema introspection backed by minidb's catalog (for migrations/codegen). */
class MinidbIntrospector implements DatabaseIntrospector {
  constructor(private readonly db: Database) {}

  async getSchemas(): Promise<SchemaMetadata[]> {
    return [{ name: "main" }];
  }

  async getTables(_options?: DatabaseMetadataOptions): Promise<TableMetadata[]> {
    return this.db.tableNames().map((name) => {
      const meta = this.db.tableMeta(name);
      const columns: ColumnMetadata[] = (meta?.columns ?? []).map((c) => ({
        name: c.name,
        dataType: kyselyDataType(c.type),
        isNullable: c.nullable,
        isAutoIncrementing: c.autoIncrement === true,
        hasDefaultValue: c.default !== undefined,
      }));
      return { name, isView: false, isForeign: false, schema: "main", columns };
    });
  }

  async getMetadata(options?: DatabaseMetadataOptions): Promise<{ tables: TableMetadata[] }> {
    return { tables: await this.getTables(options) };
  }
}

function kyselyDataType(type: ColumnType): string {
  switch (type) {
    case "INT":
      return "integer";
    case "REAL":
      return "real";
    case "TEXT":
      return "text";
    case "BOOL":
      return "boolean";
    case "BLOB":
      return "blob";
    case "DATETIME":
      return "datetime";
  }
}

function toBindValue(p: unknown): BindValue {
  if (p === null || p === undefined) return null;
  if (
    typeof p === "bigint" ||
    typeof p === "number" ||
    typeof p === "string" ||
    typeof p === "boolean"
  ) {
    return p;
  }
  if (p instanceof Date) return p;
  if (Buffer.isBuffer(p)) return p;
  if (p instanceof Uint8Array) return Buffer.from(p);
  throw new Error(`minidb: unsupported bind parameter of type ${typeof p}`);
}

function toObject(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]!] = row[i];
  return out;
}

function compiled(sql: string): CompiledQuery {
  return CompiledQuery.raw(sql);
}
