import { Database, type DatabaseOptions, type ExecResult } from "./db.js";
import type { Value } from "./record/schema.js";
import type { BindValue } from "./sql/bind.js";
import type { PreparedStatement, Row, RunResult } from "./statement.js";

/**
 * A Promise-based facade over the synchronous `Database`. The engine runs
 * synchronously (so durability ordering stays explicit), but many codebases are
 * structured around `await`; this wrapper lets minidb drop into them unchanged.
 * It also provides a `transaction` helper that commits on success and rolls back
 * on any thrown error.
 */
export class AsyncDatabase {
  private constructor(private readonly db: Database) {}

  /** Open (and recover) a database. Use ":memory:" for an in-RAM store. */
  static async open(path: string, options: DatabaseOptions = {}): Promise<AsyncDatabase> {
    return new AsyncDatabase(Database.open(path, options));
  }

  /** The underlying synchronous database, if you need a sync call. */
  get sync(): Database {
    return this.db;
  }

  async exec(sql: string, params: readonly BindValue[] = []): Promise<ExecResult> {
    return this.db.exec(sql, params);
  }

  async query(sql: string, params: readonly BindValue[] = []): Promise<Row[]> {
    return this.db.query(sql, params);
  }

  async run(sql: string, params: readonly BindValue[] = []): Promise<RunResult> {
    return this.db.run(sql, params);
  }

  prepare(sql: string): AsyncStatement {
    return new AsyncStatement(this.db.prepare(sql));
  }

  /**
   * Run `fn` inside BEGIN…COMMIT, rolling back automatically if it throws.
   * Statements issued through the provided handle run in the open transaction.
   */
  async transaction<T>(fn: (tx: AsyncTransaction) => Promise<T> | T): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn(new AsyncTransaction(this.db));
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async vacuum(): Promise<{ pagesBefore: number; pagesAfter: number }> {
    return this.db.vacuum();
  }

  async backup(targetPath: string): Promise<void> {
    this.db.backup(targetPath);
  }

  async dump(): Promise<string> {
    return this.db.dump();
  }

  tableNames(): string[] {
    return this.db.tableNames();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Statements issued inside an `AsyncDatabase.transaction` callback. */
export class AsyncTransaction {
  constructor(private readonly db: Database) {}

  async exec(sql: string, params: readonly BindValue[] = []): Promise<ExecResult> {
    return this.db.exec(sql, params);
  }
  async query(sql: string, params: readonly BindValue[] = []): Promise<Row[]> {
    return this.db.query(sql, params);
  }
  async run(sql: string, params: readonly BindValue[] = []): Promise<RunResult> {
    return this.db.run(sql, params);
  }
  prepare(sql: string): AsyncStatement {
    return new AsyncStatement(this.db.prepare(sql));
  }
}

/** A Promise-returning wrapper over a prepared statement. */
export class AsyncStatement {
  constructor(private readonly stmt: PreparedStatement) {}

  async all(...params: BindValue[]): Promise<Row[]> {
    return this.stmt.all(...params);
  }
  async get(...params: BindValue[]): Promise<Row | undefined> {
    return this.stmt.get(...params);
  }
  async values(...params: BindValue[]): Promise<Value[][]> {
    return this.stmt.values(...params);
  }
  async pluck(...params: BindValue[]): Promise<Value | undefined> {
    return this.stmt.pluck(...params);
  }
  async run(...params: BindValue[]): Promise<RunResult> {
    return this.stmt.run(...params);
  }
}
