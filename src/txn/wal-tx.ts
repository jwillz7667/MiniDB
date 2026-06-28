import { TransactionError } from "../errors.js";
import type { BufferPool } from "../storage/bufferpool.js";
import type { Tx } from "../storage/tx.js";
import type { Wal } from "./wal.js";

interface UndoEntry {
  readonly pageNo: number;
  readonly offset: number;
  readonly before: Buffer;
}

interface Run {
  start: number;
  end: number; // exclusive
}

/**
 * The disjoint [start, end) byte runs where two equal-length buffers differ.
 * Runs separated by fewer than `mergeGap` unchanged bytes are coalesced, which
 * keeps the count small without bloating each record. This matters for slotted
 * pages, whose inserts touch the header/slot at the front and the record at the
 * back — a single span would cover almost the whole page; runs log only ~the
 * record's worth of bytes.
 */
function diffRuns(before: Buffer, after: Buffer, mergeGap = 16): Run[] {
  const len = before.length;
  const raw: Run[] = [];
  let i = 0;
  while (i < len) {
    while (i < len && before[i] === after[i]) i += 1;
    if (i >= len) break;
    const start = i;
    while (i < len && before[i] !== after[i]) i += 1;
    raw.push({ start, end: i });
  }

  const merged: Run[] = [];
  for (const run of raw) {
    const last = merged[merged.length - 1];
    if (last && run.start - last.end <= mergeGap) last.end = run.end;
    else merged.push({ ...run });
  }
  return merged;
}

/**
 * A transaction that journals every page mutation to the WAL. The access methods
 * (heap, B+Tree) stay logging-agnostic: they just call `modify`, which snapshots
 * the page, runs the mutator, and logs the minimal changed byte span as an
 * UPDATE record before marking the page dirty. The before-images are also kept
 * in memory so the transaction can roll itself back (logging compensation
 * records as it does — see `applyUndo`).
 *
 * Single-writer model: at most one WalTx mutates at a time, so the only true
 * in-flight "loser" after a crash is the final transaction that had neither
 * committed nor aborted. Recovery undoes exactly those (an aborted transaction
 * is reverted by its own logged CLRs, not by the undo pass), which is what keeps
 * the physical redo/undo correct even when a committed write follows an aborted
 * one on the same bytes.
 */
export class WalTx implements Tx {
  private readonly undoLog: UndoEntry[] = [];
  private finished = false;

  constructor(
    private readonly pool: BufferPool,
    private readonly wal: Wal,
    readonly txid: bigint,
  ) {}

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
    if (this.finished) throw new TransactionError(`transaction ${this.txid} is already finished`);

    const page = this.pool.fetchPage(pageNo);
    const snapshot = Buffer.from(page);
    let dirty = false;
    try {
      mutator(page);
      for (const run of diffRuns(snapshot, page)) {
        const before = Buffer.from(snapshot.subarray(run.start, run.end));
        const after = Buffer.from(page.subarray(run.start, run.end));
        const lsn = this.wal.append({
          type: "update",
          txid: this.txid,
          pageNo,
          offset: run.start,
          before,
          after,
        });
        this.pool.setPageLSN(pageNo, lsn);
        this.undoLog.push({ pageNo, offset: run.start, before });
        dirty = true;
      }
    } finally {
      // Mutators validate before writing, so a thrown mutator leaves the page
      // unchanged; unpin(false) never clears an existing dirty flag.
      this.pool.unpin(pageNo, dirty);
    }
  }

  /**
   * Roll the transaction back by replaying its before-images in reverse — and,
   * crucially, LOG each restoration as a compensation record (CLR). Without
   * CLRs the rollback would be invisible to the log: recovery's redo would
   * re-apply this transaction's after-images and nothing would revert them,
   * while its before-images would still sit in the log, eligible to clobber a
   * value a *later committed* transaction wrote to the same bytes. With CLRs,
   * redo reconstructs the rolled-back state and recovery never undoes an aborted
   * transaction (only true in-flight losers are undone).
   */
  applyUndo(): void {
    for (let i = this.undoLog.length - 1; i >= 0; i--) {
      const u = this.undoLog[i]!;
      const page = this.pool.fetchPage(u.pageNo);
      try {
        const current = Buffer.from(page.subarray(u.offset, u.offset + u.before.length));
        const lsn = this.wal.append({
          type: "update",
          txid: this.txid,
          pageNo: u.pageNo,
          offset: u.offset,
          before: current,
          after: u.before,
        });
        this.pool.setPageLSN(u.pageNo, lsn);
        u.before.copy(page, u.offset);
      } finally {
        this.pool.unpin(u.pageNo, true);
      }
    }
  }

  markFinished(): void {
    this.finished = true;
  }

  get isFinished(): boolean {
    return this.finished;
  }
}
