/**
 * Multi-Version Concurrency Control (snapshot isolation).
 *
 * Every row version carries `xmin` (the transaction that created it) and `xmax`
 * (the transaction that deleted/superseded it, or 0). A transaction takes a
 * snapshot at BEGIN — the set of transactions that had committed before it
 * started — and only ever sees versions consistent with that snapshot. Readers
 * never block writers and never see a writer's in-flight work.
 *
 * Snapshot isolation differs from serializable in one documented way: it permits
 * *write skew*. Two transactions can each read a set of rows, then each update a
 * different row based on what they read, and both commit — producing a state no
 * serial order could. Detecting that needs predicate locking / SSI, which this
 * engine does not implement.
 */

export type TxnStatus = "active" | "committed" | "aborted";

/** A consistent point-in-time view: txids < xmax that were not in-flight at BEGIN. */
export interface Snapshot {
  /** Exclusive upper bound: any txid >= xmax started after this snapshot. */
  readonly xmax: bigint;
  /** Transactions that were still in-progress when this snapshot was taken. */
  readonly active: ReadonlySet<bigint>;
}

export class Transaction {
  constructor(
    readonly txid: bigint,
    readonly snapshot: Snapshot,
  ) {}
}

/** The reserved txid meaning "no transaction" (e.g. xmax of a live version). */
export const NO_TXN = 0n;

export class TransactionManager {
  private nextTxid = 1n;
  private readonly status = new Map<bigint, TxnStatus>();

  /** Begin a transaction and capture its snapshot of currently-committed state. */
  begin(): Transaction {
    const txid = this.nextTxid;
    this.nextTxid += 1n;
    this.status.set(txid, "active");

    const active = new Set<bigint>();
    for (const [id, st] of this.status) {
      if (st === "active" && id !== txid) active.add(id);
    }
    return new Transaction(txid, { xmax: this.nextTxid, active });
  }

  commit(tx: Transaction): void {
    this.status.set(tx.txid, "committed");
  }

  rollback(tx: Transaction): void {
    this.status.set(tx.txid, "aborted");
  }

  statusOf(txid: bigint): TxnStatus {
    return this.status.get(txid) ?? "aborted";
  }

  /** Has `other` committed in a way that is visible to `tx`'s snapshot? */
  private committedToSnapshot(tx: Transaction, other: bigint): boolean {
    if (other === tx.txid) return true; // a transaction always sees its own writes
    if (other >= tx.snapshot.xmax) return false; // started after our snapshot
    if (tx.snapshot.active.has(other)) return false; // in-flight when we began
    return this.statusOf(other) === "committed";
  }

  /**
   * Is a version (created by `xmin`, deleted by `xmax`) visible to `tx`?
   * Visible iff its creator is committed-to-our-snapshot and its deleter is not.
   */
  isVisible(tx: Transaction, xmin: bigint, xmax: bigint): boolean {
    if (!this.committedToSnapshot(tx, xmin)) return false;
    if (xmax !== NO_TXN && this.committedToSnapshot(tx, xmax)) return false;
    return true;
  }

  /**
   * May `tx` delete/update a version whose current xmax is `xmax`? Conflicts if
   * another transaction has already deleted it and that delete is not invisibly
   * aborted (first-updater-wins).
   */
  canWrite(tx: Transaction, xmax: bigint): boolean {
    if (xmax === NO_TXN || xmax === tx.txid) return true;
    return this.statusOf(xmax) === "aborted";
  }
}
