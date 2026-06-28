import { INVALID_PAGE } from "./constants.js";
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
import { parse, parseMany } from "./sql/parser.js";
import type { Statement } from "./sql/ast.js";
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
  | { readonly type: "rollback" };

/**
 * The top-level database: a durable, single-file SQL engine. Ties together the
 * pager, buffer pool, WAL, catalog, and executor, and owns the (single-writer)
 * transaction lifecycle. On open it recovers from the WAL; each statement runs
 * in an autocommit transaction unless wrapped in BEGIN/COMMIT/ROLLBACK.
 */
export class Database {
  private current: WalTx | null = null;
  private nextTxid: bigint;
  private readonly active = new Set<bigint>();
  private lastRecovery: RecoveryStats;

  private constructor(
    private readonly pager: Pager,
    private readonly pool: BufferPool,
    private readonly wal: Wal,
    private readonly catalog: Catalog,
    private readonly store: TableStore,
    private readonly heap: Heap,
    private readonly rowids: RowIdAllocator,
    private readonly readTx: DirectTx,
    private readonly lock: FileLock,
    private readonly maxSortRows: number,
    recovery: RecoveryStats,
  ) {
    this.lastRecovery = recovery;
    this.nextTxid =
      recovery.maxTxid > 0n ? recovery.maxTxid + 1n : pager.getNextTxid();
  }

  static open(path: string, options: DatabaseOptions = {}): Database {
    // Refuse to open a file another live instance holds (would corrupt it).
    const lock = FileLock.acquire(path);
    try {
      return Database.openLocked(path, options, lock);
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  private static openLocked(path: string, options: DatabaseOptions, lock: FileLock): Database {
    const durability = new Durability(options.synchronous ?? "full");
    const pager = Pager.open(path, durability);
    const wal = Wal.open(`${path}-wal`, durability);

    // Replay the WAL into the data file before anything caches a page.
    const recovery = recover(pager, wal);
    if (recovery.records > 0) {
      wal.truncate();
      wal.setNextLsn(recovery.maxLsn + 1n);
    }

    const pool = new BufferPool(pager, options.poolSize ?? 256);
    pool.setBeforeFlush(() => wal.flush()); // write-ahead rule

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
    const rowids = new RowIdAllocator();
    return new Database(
      pager,
      pool,
      wal,
      catalog,
      store,
      heap,
      rowids,
      new DirectTx(pool),
      lock,
      options.maxSortRows ?? DEFAULT_MAX_SORT_ROWS,
      recovery,
    );
  }

  /** Execute one SQL statement. */
  exec(sql: string): ExecResult {
    return this.run(parse(sql));
  }

  /** Execute several `;`-separated statements, returning each result. */
  execMany(sql: string): ExecResult[] {
    return parseMany(sql).map((stmt) => this.run(stmt));
  }

  private run(stmt: Statement): ExecResult {
    if (stmt.kind === "begin" || stmt.kind === "commit" || stmt.kind === "rollback") {
      return this.control(stmt.kind);
    }
    // Read-only statements touch no pages durably, so they skip the transaction
    // machinery entirely — no BEGIN/COMMIT, no fsync. They still read through the
    // shared buffer pool, so an open transaction's uncommitted writes are visible.
    if (stmt.kind === "select" || stmt.kind === "explain") {
      const ctx: ExecContext = {
        tx: this.readTx,
        catalog: this.catalog,
        store: this.store,
        rowids: this.rowids,
        maxSortRows: this.maxSortRows,
      };
      return new Executor(ctx, this.catalog).run(stmt);
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

  private execute(tx: WalTx, stmt: Statement): QueryResult {
    const ctx: ExecContext = {
      tx,
      catalog: this.catalog,
      store: this.store,
      rowids: this.rowids,
      maxSortRows: this.maxSortRows,
    };
    return new Executor(ctx, this.catalog).run(stmt);
  }

  private begin(): WalTx {
    const txid = this.nextTxid;
    this.nextTxid += 1n;
    this.wal.append({ type: "begin", txid });
    this.active.add(txid);
    return new WalTx(this.pool, this.wal, txid);
  }

  private commit(tx: WalTx): void {
    this.wal.append({ type: "commit", txid: tx.txid });
    this.wal.flushForCommit(); // commit is durable once its record is flushed
    this.active.delete(tx.txid);
    tx.markFinished();
  }

  private rollback(tx: WalTx): void {
    tx.applyUndo();
    this.wal.append({ type: "abort", txid: tx.txid });
    this.wal.flushForCommit();
    this.active.delete(tx.txid);
    tx.markFinished();
    // The undo may have shrunk heap chains and rewound rowid/btree state, so
    // drop in-memory hints that could now point at orphaned pages.
    this.rowids.reset();
    this.heap.resetCache();
  }

  /**
   * Flush all dirty pages into the data file and record a checkpoint, so future
   * recovery can start redo from here instead of the beginning of the log.
   */
  checkpoint(): void {
    this.pool.flushAll(); // honors the write-ahead rule via the flush hook
    this.wal.append({ type: "checkpoint", active: [...this.active] });
    this.wal.flush(); // a checkpoint must be durable, so a hard barrier
    this.pager.setNextTxid(this.nextTxid);
  }

  /** Stats from the WAL replay performed when this database was opened. */
  recoveryStats(): RecoveryStats {
    return this.lastRecovery;
  }

  /** Names of user tables (system tables excluded). */
  tableNames(): string[] {
    return this.catalog.listTables().map((t) => t.name);
  }

  tableMeta(name: string): TableMeta | undefined {
    return this.catalog.getTable(name);
  }

  /** Buffer-pool cache hit rate since open (or last reset). */
  hitRate(): number {
    return this.pool.hitRate();
  }

  /** Cleanly close: roll back any open transaction, checkpoint, and release files. */
  close(): void {
    if (this.current) {
      this.rollback(this.current);
      this.current = null;
    }
    this.checkpoint();
    this.wal.close();
    this.pager.close();
    this.lock.release();
  }
}
