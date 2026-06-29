import { renameSync, rmSync } from "node:fs";

import { INVALID_PAGE } from "./constants.js";
import { reconstructCreateIndex, reconstructCreateTable } from "./ddl.js";
import { TransactionError } from "./errors.js";
import { DEFAULT_MAX_SORT_ROWS, RowIdAllocator, type ExecContext } from "./exec/context.js";
import { Executor, type QueryResult } from "./exec/executor.js";
import { TableStore } from "./exec/table-store.js";
import { Catalog, type TableMeta } from "./record/catalog.js";
import { BufferPool } from "./storage/bufferpool.js";
import { Durability, type SyncMode } from "./storage/durability.js";
import { Heap } from "./storage/heap.js";
import { FileLock } from "./storage/lock.js";
import { Pager } from "./storage/pager.js";
import { DirectTx } from "./storage/tx.js";
import { parseMany, parsePrepared } from "./sql/parser.js";
import { bindStatement, type BindValue } from "./sql/bind.js";
import type { Statement } from "./sql/ast.js";
import { PreparedStatement, type Row, type RunResult } from "./statement.js";
import { recover, type RecoveryStats } from "./txn/recovery.js";
import { WalTx } from "./txn/wal-tx.js";
import { Wal } from "./txn/wal.js";

export interface DatabaseOptions {
  /** Number of frames in the buffer pool. */
  readonly poolSize?: number;
  /** Durability policy: "full" (default, safest), "normal", or "off". */
  readonly synchronous?: SyncMode;
  /** Max rows an unbounded (no-LIMIT) ORDER BY may buffer before failing safe. */
  readonly maxSortRows?: number;
}

/** Result of a control statement plus everything the executor can return. */
export type ExecResult =
  | QueryResult
  | { readonly type: "begin" }
  | { readonly type: "commit" }
  | { readonly type: "rollback" }
  | { readonly type: "vacuum"; readonly pagesBefore: number; readonly pagesAfter: number };

/** The per-open engine components, grouped so VACUUM can rebuild them in place. */
interface Engine {
  readonly pager: Pager;
  readonly pool: BufferPool;
  readonly wal: Wal;
  readonly catalog: Catalog;
  readonly store: TableStore;
  readonly heap: Heap;
  readonly rowids: RowIdAllocator;
  readonly readTx: DirectTx;
  readonly recovery: RecoveryStats;
}

/**
 * The top-level database: a durable, single-file SQL engine. Ties together the
 * pager, buffer pool, WAL, catalog, and executor, and owns the (single-writer)
 * transaction lifecycle. On open it recovers from the WAL; each statement runs
 * in an autocommit transaction unless wrapped in BEGIN/COMMIT/ROLLBACK.
 */
export class Database {
  private engine: Engine;
  private current: WalTx | null = null;
  private nextTxid: bigint;
  private readonly active = new Set<bigint>();

  private constructor(
    engine: Engine,
    private readonly path: string,
    private readonly lock: FileLock,
    private readonly options: DatabaseOptions,
    private readonly maxSortRows: number,
  ) {
    this.engine = engine;
    this.nextTxid =
      engine.recovery.maxTxid > 0n ? engine.recovery.maxTxid + 1n : engine.pager.getNextTxid();
  }

  static open(path: string, options: DatabaseOptions = {}): Database {
    // Refuse to open a file another live instance holds (would corrupt it).
    const lock = FileLock.acquire(path);
    try {
      const engine = Database.buildEngine(path, options);
      return new Database(engine, path, lock, options, options.maxSortRows ?? DEFAULT_MAX_SORT_ROWS);
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  /** Open + recover the engine for `path`. Closes its fds if anything throws. */
  private static buildEngine(path: string, options: DatabaseOptions): Engine {
    const durability = new Durability(options.synchronous ?? "full");
    const pager = Pager.open(path, durability);
    let wal: Wal | undefined;
    try {
      wal = Wal.open(`${path}-wal`, durability);

      // Replay the WAL into the data file before anything caches a page.
      const recovery = recover(pager, wal);
      if (recovery.records > 0) {
        wal.truncate();
        wal.setNextLsn(recovery.maxLsn + 1n);
      }

      const pool = new BufferPool(pager, options.poolSize ?? 256);
      pool.setBeforeFlush(() => wal!.flush()); // write-ahead rule

      const heap = new Heap();
      const fresh = pager.getCatalogRoot() === INVALID_PAGE;
      // Bootstrap/load the catalog directly (the cold-start path is fsync'd, not
      // logged); subsequent DDL/DML go through the WAL.
      const catalog = Catalog.open(new DirectTx(pool), pager, heap);
      if (fresh) {
        // Order matters: make the catalog pages durable, THEN record the header
        // pointer to them. A crash before the pointer is written simply re-runs a
        // fresh bootstrap; the reverse order could point the header at unwritten
        // pages and leave the database unopenable.
        pool.flushAll();
        pager.setCatalogRoot(catalog.rootPage());
      }

      const store = new TableStore(catalog, heap);
      return { pager, pool, wal, catalog, store, heap, rowids: new RowIdAllocator(), readTx: new DirectTx(pool), recovery };
    } catch (err) {
      wal?.close();
      pager.close();
      throw err;
    }
  }

  /**
   * Execute one SQL statement, optionally binding `?` placeholders. Passing user
   * input via `params` is the injection-safe path — values are bound, never
   * spliced into SQL text.
   */
  exec(sql: string, params: readonly BindValue[] = []): ExecResult {
    const { statement, paramCount } = parsePrepared(sql);
    return this.dispatch(bindStatement(statement, params, paramCount));
  }

  /** Execute several `;`-separated statements, returning each result. */
  execMany(sql: string): ExecResult[] {
    return parseMany(sql).map((stmt) => this.dispatch(stmt));
  }

  /**
   * Parse a statement once and return a reusable, parameterized handle. The
   * returned object's `all`/`get`/`values`/`pluck`/`run` methods bind values to
   * `?` placeholders safely — the recommended way to pass any external input.
   */
  prepare(sql: string): PreparedStatement {
    const { statement, paramCount } = parsePrepared(sql);
    return new PreparedStatement(sql, statement, paramCount, (stmt) => this.dispatch(stmt));
  }

  /** One-shot query: prepare, bind, and return rows as objects keyed by column. */
  query(sql: string, params: readonly BindValue[] = []): Row[] {
    return this.prepare(sql).all(params);
  }

  /** One-shot mutation: prepare, bind, and report rows changed + last rowid. */
  run(sql: string, params: readonly BindValue[] = []): RunResult {
    return this.prepare(sql).run(params);
  }

  private dispatch(stmt: Statement): ExecResult {
    if (stmt.kind === "begin" || stmt.kind === "commit" || stmt.kind === "rollback") {
      return this.control(stmt.kind);
    }
    if (stmt.kind === "vacuum") {
      return { type: "vacuum", ...this.vacuum() };
    }
    // Read-only statements touch no pages durably, so they skip the transaction
    // machinery entirely — no BEGIN/COMMIT, no fsync. They still read through the
    // shared buffer pool, so an open transaction's uncommitted writes are visible.
    if (stmt.kind === "select" || stmt.kind === "explain") {
      return new Executor(this.context(this.engine.readTx), this.engine.catalog).run(stmt);
    }
    if (this.current) {
      if (stmt.kind === "createTable" || stmt.kind === "createIndex") {
        throw new TransactionError("DDL is not allowed inside an explicit transaction");
      }
      return this.execute(this.current, stmt);
    }
    // Autocommit: one transaction per statement.
    const tx = this.begin();
    try {
      const result = this.execute(tx, stmt);
      this.commit(tx);
      return result;
    } catch (err) {
      this.rollback(tx);
      throw err;
    }
  }

  private control(kind: "begin" | "commit" | "rollback"): ExecResult {
    if (kind === "begin") {
      if (this.current) throw new TransactionError("a transaction is already in progress");
      this.current = this.begin();
      return { type: "begin" };
    }
    if (!this.current) throw new TransactionError(`no transaction to ${kind}`);
    if (kind === "commit") this.commit(this.current);
    else this.rollback(this.current);
    this.current = null;
    return { type: kind };
  }

  private context(tx: DirectTx | WalTx): ExecContext {
    return {
      tx,
      catalog: this.engine.catalog,
      store: this.engine.store,
      rowids: this.engine.rowids,
      maxSortRows: this.maxSortRows,
    };
  }

  private execute(tx: WalTx, stmt: Statement): QueryResult {
    return new Executor(this.context(tx), this.engine.catalog).run(stmt);
  }

  private begin(): WalTx {
    const txid = this.nextTxid;
    this.nextTxid += 1n;
    this.engine.wal.append({ type: "begin", txid });
    this.active.add(txid);
    return new WalTx(this.engine.pool, this.engine.wal, txid);
  }

  private commit(tx: WalTx): void {
    this.engine.wal.append({ type: "commit", txid: tx.txid });
    this.engine.wal.flushForCommit(); // commit is durable once its record is flushed
    this.active.delete(tx.txid);
    tx.markFinished();
  }

  private rollback(tx: WalTx): void {
    tx.applyUndo();
    this.engine.wal.append({ type: "abort", txid: tx.txid });
    this.engine.wal.flushForCommit();
    this.active.delete(tx.txid);
    tx.markFinished();
    // The undo may have shrunk heap chains and rewound rowid/btree state, so
    // drop in-memory hints that could now point at orphaned pages.
    this.engine.rowids.reset();
    this.engine.heap.resetCache();
  }

  /**
   * Flush all dirty pages into the data file and record a checkpoint, so future
   * recovery can start redo from here instead of the beginning of the log.
   */
  checkpoint(): void {
    this.engine.pool.flushAll(); // honors the write-ahead rule via the flush hook
    this.engine.wal.append({ type: "checkpoint", active: [...this.active] });
    this.engine.wal.flush(); // a checkpoint must be durable, so a hard barrier
    this.engine.pager.setNextTxid(this.nextTxid);
  }

  /**
   * Rebuild the database into a fresh, compacted file and swap it in, reclaiming
   * space held by tombstoned rows, dead overflow chains, and fragmentation. Live
   * data and schema (constraints, indexes, defaults) are preserved; internal
   * rowids are reassigned. Cannot run inside an explicit transaction.
   */
  vacuum(): { pagesBefore: number; pagesAfter: number } {
    if (this.current) throw new TransactionError("cannot VACUUM inside a transaction");
    this.checkpoint();
    const pagesBefore = this.engine.pager.pageCount();

    const tmp = `${this.path}.vacuum-${process.pid}`;
    for (const suffix of ["", "-wal", "-lock"]) rmSync(`${tmp}${suffix}`, { force: true });
    this.copyInto(tmp);

    // Close the old engine (keeping our lock on `path`), put the compacted file
    // in its place, drop the now-stale WAL, and re-open in place.
    this.engine.wal.close();
    this.engine.pager.close();
    renameSync(tmp, this.path);
    rmSync(`${tmp}-wal`, { force: true });
    rmSync(`${tmp}-lock`, { force: true });
    rmSync(`${this.path}-wal`, { force: true });

    this.engine = Database.buildEngine(this.path, this.options);
    this.nextTxid =
      this.engine.recovery.maxTxid > 0n
        ? this.engine.recovery.maxTxid + 1n
        : this.engine.pager.getNextTxid();
    return { pagesBefore, pagesAfter: this.engine.pager.pageCount() };
  }

  /** Build a compacted copy of this database at `targetPath` (live data only). */
  private copyInto(targetPath: string): void {
    const dest = Database.open(targetPath, this.options);
    try {
      for (const table of this.engine.catalog.listTables()) {
        dest.exec(reconstructCreateTable(table));
        for (const index of this.engine.catalog.getIndexes(table.name)) {
          if (!index.unique) dest.exec(reconstructCreateIndex(table.name, index.columnName));
        }
        const cols = table.columns.map((c) => c.name);
        const insert = dest.prepare(
          `INSERT INTO ${table.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        );
        for (const row of this.engine.store.scan(this.engine.readTx, table)) {
          insert.run(...row.values);
        }
      }
      dest.checkpoint();
    } finally {
      dest.close();
    }
  }

  /** Stats from the WAL replay performed when this database was opened. */
  recoveryStats(): RecoveryStats {
    return this.engine.recovery;
  }

  /** Names of user tables (system tables excluded). */
  tableNames(): string[] {
    return this.engine.catalog.listTables().map((t) => t.name);
  }

  tableMeta(name: string): TableMeta | undefined {
    return this.engine.catalog.getTable(name);
  }

  /** Buffer-pool cache hit rate since open (or last reset). */
  hitRate(): number {
    return this.engine.pool.hitRate();
  }

  /** Cleanly close: roll back any open transaction, checkpoint, and release files. */
  close(): void {
    if (this.current) {
      this.rollback(this.current);
      this.current = null;
    }
    this.checkpoint();
    this.engine.wal.close();
    this.engine.pager.close();
    this.lock.release();
  }
}
