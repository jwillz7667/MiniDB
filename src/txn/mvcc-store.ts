import { U64 } from "../constants.js";
import { TransactionError } from "../errors.js";
import type { Schema, Value } from "../record/schema.js";
import { deserialize, serialize } from "../record/tuple.js";
import type { Heap } from "../storage/heap.js";
import { recordOffset } from "../storage/page.js";
import type { Rid } from "../storage/rid.js";
import type { Tx } from "../storage/tx.js";
import { NO_TXN, type Transaction, type TransactionManager } from "./transaction.js";

const XMIN_OFFSET = 0;
const XMAX_OFFSET = U64;
const TUPLE_OFFSET = U64 * 2;

interface Version {
  readonly xmin: bigint;
  readonly xmax: bigint;
  readonly values: Value[];
}

/**
 * A versioned row store: ordinary heap records prefixed with (xmin, xmax). An
 * UPDATE never overwrites in place — it stamps xmax on the old version and
 * appends a new one — so concurrent snapshots keep seeing the version that was
 * current when they began. Dead versions accumulate (a vacuum would reclaim
 * them; out of scope, matching the engine's deferred-reclamation policy).
 */
export class MvccStore {
  constructor(
    private readonly heap: Heap,
    private readonly schema: Schema,
  ) {}

  create(tx: Tx): number {
    return this.heap.create(tx);
  }

  /** Insert a fresh version visible to `txn` and (once committed) its successors. */
  insert(tx: Tx, txn: Transaction, root: number, values: Value[]): Rid {
    const tuple = serialize(this.schema, values);
    const rec = Buffer.alloc(TUPLE_OFFSET + tuple.length);
    rec.writeBigUInt64LE(txn.txid, XMIN_OFFSET);
    rec.writeBigUInt64LE(NO_TXN, XMAX_OFFSET);
    tuple.copy(rec, TUPLE_OFFSET);
    return this.heap.insert(tx, root, rec);
  }

  /** Logically delete the version at `rid` by stamping its xmax with `txn`. */
  delete(tx: Tx, mgr: TransactionManager, txn: Transaction, rid: Rid): void {
    const v = this.versionAt(tx, rid);
    if (!mgr.isVisible(txn, v.xmin, v.xmax)) {
      throw new TransactionError("cannot delete a row not visible to this transaction");
    }
    if (!mgr.canWrite(txn, v.xmax)) {
      throw new TransactionError("write-write conflict: row was updated by a concurrent transaction");
    }
    tx.modify(rid.pageNo, (page) => {
      page.writeBigUInt64LE(txn.txid, recordOffset(page, rid.slot) + XMAX_OFFSET);
    });
  }

  /** Update = delete the visible version and insert a new one. Returns the new rid. */
  update(
    tx: Tx,
    mgr: TransactionManager,
    txn: Transaction,
    root: number,
    rid: Rid,
    values: Value[],
  ): Rid {
    this.delete(tx, mgr, txn, rid);
    return this.insert(tx, txn, root, values);
  }

  /** The value of the version at `rid`, or null if it is not visible to `txn`. */
  readVisible(tx: Tx, mgr: TransactionManager, txn: Transaction, rid: Rid): Value[] | null {
    const v = this.versionAt(tx, rid);
    return mgr.isVisible(txn, v.xmin, v.xmax) ? v.values : null;
  }

  /** Every version visible to `txn`, in physical order. */
  *scanVisible(
    tx: Tx,
    mgr: TransactionManager,
    txn: Transaction,
    root: number,
  ): Generator<{ rid: Rid; values: Value[] }> {
    for (const rec of this.heap.scan(tx, root)) {
      const xmin = rec.bytes.readBigUInt64LE(XMIN_OFFSET);
      const xmax = rec.bytes.readBigUInt64LE(XMAX_OFFSET);
      if (mgr.isVisible(txn, xmin, xmax)) {
        yield { rid: rec.rid, values: deserialize(this.schema, rec.bytes.subarray(TUPLE_OFFSET)) };
      }
    }
  }

  /** Total number of physical versions (live or dead) — useful for vacuum metrics. */
  versionCount(tx: Tx, root: number): number {
    let n = 0;
    for (const _ of this.heap.scan(tx, root)) n += 1;
    return n;
  }

  private versionAt(tx: Tx, rid: Rid): Version {
    const bytes = this.heap.get(tx, rid);
    return {
      xmin: bytes.readBigUInt64LE(XMIN_OFFSET),
      xmax: bytes.readBigUInt64LE(XMAX_OFFSET),
      values: deserialize(this.schema, bytes.subarray(TUPLE_OFFSET)),
    };
  }
}
