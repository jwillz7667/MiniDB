import type { Pager } from "../storage/pager.js";
import type { Wal, WalRecord } from "./wal.js";

export interface RecoveryStats {
  /** Total valid records read from the WAL. */
  readonly records: number;
  /** Number of transactions seen committed. */
  readonly committed: number;
  /** UPDATE records re-applied during redo. */
  readonly redone: number;
  /** UPDATE records reverted during undo. */
  readonly undone: number;
  /** LSN redo started from (the last checkpoint, or 0 if none). */
  readonly redoStartLsn: bigint;
  /** Highest txid observed (used to seed the next txid). */
  readonly maxTxid: bigint;
  /** Highest LSN observed (used to seed the next LSN). */
  readonly maxLsn: bigint;
}

const EMPTY: RecoveryStats = {
  records: 0,
  committed: 0,
  redone: 0,
  undone: 0,
  redoStartLsn: 0n,
  maxTxid: 0n,
  maxLsn: 0n,
};

/**
 * ARIES-lite recovery (STEAL + NO-FORCE). Three passes over the WAL:
 *
 *   Analysis — find committed transactions and the last checkpoint.
 *   Redo     — re-apply every logged after-image from the last checkpoint
 *              forward, rebuilding pages the no-force policy left only in the log.
 *   Undo     — over the whole log, latest first, revert before-images for
 *              "loser" transactions (begun but never committed), unwinding the
 *              steal policy's premature page writes.
 *
 * Touched pages are buffered and written back once at the end. Page allocation
 * is durable for free: an UPDATE past EOF grows the file (zero-filled) first.
 */
export function recover(pager: Pager, wal: Wal): RecoveryStats {
  const records = wal.readAll();
  if (records.length === 0) return EMPTY;

  const committed = new Set<bigint>();
  let lastCheckpointIdx = -1;
  let maxLsn = 0n;
  let maxTxid = 0n;
  records.forEach((r, i) => {
    if (r.lsn > maxLsn) maxLsn = r.lsn;
    if (r.type !== "checkpoint" && r.txid > maxTxid) maxTxid = r.txid;
    if (r.type === "commit") committed.add(r.txid);
    if (r.type === "checkpoint") lastCheckpointIdx = i;
  });
  const redoStartLsn = lastCheckpointIdx >= 0 ? records[lastCheckpointIdx]!.lsn : 0n;

  // Buffer touched pages so each is read and written exactly once.
  const dirty = new Map<number, Buffer>();
  const pageOf = (pageNo: number): Buffer => {
    let page = dirty.get(pageNo);
    if (!page) {
      pager.ensurePageCount(pageNo + 1); // make allocation durable
      page = pager.readPage(pageNo);
      dirty.set(pageNo, page);
    }
    return page;
  };

  let redone = 0;
  for (let i = lastCheckpointIdx + 1; i < records.length; i++) {
    const r = records[i]!;
    if (r.type === "update") {
      r.after.copy(pageOf(r.pageNo), r.offset);
      redone += 1;
    }
  }

  let undone = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.type === "update" && !committed.has(r.txid)) {
      r.before.copy(pageOf(r.pageNo), r.offset);
      undone += 1;
    }
  }

  for (const [pageNo, page] of dirty) pager.writePage(pageNo, page, false);
  pager.sync();

  return {
    records: records.length,
    committed: committed.size,
    redone,
    undone,
    redoStartLsn,
    maxTxid,
    maxLsn,
  };
}

/** Convenience for tests/tools: does this record list contain a checkpoint? */
export function hasCheckpoint(records: WalRecord[]): boolean {
  return records.some((r) => r.type === "checkpoint");
}
