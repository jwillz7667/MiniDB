import { BufferPool } from "../../src/storage/bufferpool.js";
import { Pager } from "../../src/storage/pager.js";
import { DirectTx } from "../../src/storage/tx.js";
import { makeTempDb, type TempDb } from "./tmp.js";

/**
 * A minimal storage stack (pager + buffer pool + non-logging transaction) for
 * exercising access methods directly, without the SQL/WAL layers on top.
 */
export interface StorageStack {
  readonly tmp: TempDb;
  readonly pager: Pager;
  readonly pool: BufferPool;
  readonly tx: DirectTx;
  /** Flush everything and close the file (keeps the temp dir for reopen). */
  flushClose(): void;
  /** Remove the temp directory entirely. */
  cleanup(): void;
}

export function makeStorage(capacity = 64, tmp: TempDb = makeTempDb()): StorageStack {
  const pager = Pager.open(tmp.path);
  const pool = new BufferPool(pager, capacity);
  return {
    tmp,
    pager,
    pool,
    tx: new DirectTx(pool),
    flushClose() {
      pool.flushAll();
      pager.close();
    },
    cleanup() {
      tmp.cleanup();
    },
  };
}
