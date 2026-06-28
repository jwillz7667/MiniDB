import { BufferPool } from "./bufferpool.js";

/**
 * The single channel through which access methods (heap, B+Tree) touch pages.
 * They never mutate a page buffer directly; every change is wrapped in
 * `modify`, which lets a transaction journal it transparently.
 *
 *  - `read`/`release`  pin a page for inspection and let it go.
 *  - `allocate`        grow the file by one zero-filled page.
 *  - `modify`          pin a page, run a mutator over its buffer, then mark it
 *                      dirty (and, for a WAL-backed tx, log the changed bytes).
 *
 * Two implementations exist: `DirectTx` (no logging — for low-level unit tests
 * and non-durable contexts) and `WalTx` (Phase 6 — logs every mutation).
 */
export interface Tx {
  read(pageNo: number): Buffer;
  release(pageNo: number): void;
  allocate(): number;
  modify(pageNo: number, mutator: (page: Buffer) => void): void;
}

/**
 * A transaction that applies changes straight to the buffer pool with no
 * write-ahead logging. Durable only insofar as the pool is later flushed; used
 * where recovery is out of scope (the storage unit tests, bulk bootstrap).
 */
export class DirectTx implements Tx {
  constructor(private readonly pool: BufferPool) {}

  read(pageNo: number): Buffer {
    return this.pool.fetchPage(pageNo);
  }

  release(pageNo: number): void {
    this.pool.unpin(pageNo, false);
  }

  allocate(): number {
    return this.pool.allocatePage();
  }

  modify(pageNo: number, mutator: (page: Buffer) => void): void {
    const page = this.pool.fetchPage(pageNo);
    mutator(page);
    this.pool.unpin(pageNo, true);
  }
}
