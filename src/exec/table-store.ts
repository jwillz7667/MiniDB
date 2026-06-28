import { I64, INVALID_PAGE, U32, U8 } from "../constants.js";
import { ExecutionError } from "../errors.js";
import type { Catalog, TableMeta } from "../record/catalog.js";
import { columnIndex, type Value } from "../record/schema.js";
import { deserialize, serialize } from "../record/tuple.js";
import { BTree } from "../storage/btree.js";
import type { Heap } from "../storage/heap.js";
import { MAX_RECORD_SIZE } from "../storage/page.js";
import { readOverflow, writeOverflow } from "../storage/overflow.js";
import type { Rid } from "../storage/rid.js";
import type { Tx } from "../storage/tx.js";

/** A row materialized from the heap, with its internal rowid and physical rid. */
export interface ScannedRow {
  readonly rowid: bigint;
  readonly rid: Rid;
  readonly values: Value[];
}

/** Heap-record kinds (the byte right after the rowid prefix, for user rows). */
const INLINE = 0; // the tuple bytes follow directly
const OVERFLOW = 1; // a pointer: [firstPage:u32][totalLen:u32] into an overflow chain
const HEADER = I64 + U8; // rowid + kind byte

/**
 * The bridge between logical rows and physical storage for a single table.
 * Every user row is stored as an 8-byte rowid prefix, a 1-byte kind marker, and
 * then either the serialized tuple inline or — when the tuple is larger than a
 * heap page — a pointer to an overflow chain holding the tuple bytes. The rowid
 * is the primary B+Tree key and lets DELETE/UPDATE maintain the indexes. System
 * tables (pkRoot === INVALID_PAGE) carry no rowid prefix and are read-only.
 */
export class TableStore {
  constructor(
    private readonly catalog: Catalog,
    private readonly heap: Heap,
  ) {}

  private hasRowId(table: TableMeta): boolean {
    return table.pkRoot !== INVALID_PAGE;
  }

  /**
   * Build the heap record for a row: inline when it fits a page, otherwise an
   * overflow stub (writing the tuple bytes to a fresh overflow chain as a side
   * effect). Used by both insert and update.
   */
  private encodeRecord(tx: Tx, table: TableMeta, rowid: bigint, values: Value[]): Buffer {
    const tuple = serialize(table.schema, values);
    const inline = Buffer.alloc(HEADER + tuple.length);
    inline.writeBigInt64LE(rowid, 0);
    inline.writeUInt8(INLINE, I64);
    tuple.copy(inline, HEADER);
    if (inline.length <= MAX_RECORD_SIZE) return inline;

    const firstPage = writeOverflow(tx, tuple);
    const stub = Buffer.alloc(HEADER + U32 + U32);
    stub.writeBigInt64LE(rowid, 0);
    stub.writeUInt8(OVERFLOW, I64);
    stub.writeUInt32LE(firstPage, HEADER);
    stub.writeUInt32LE(tuple.length, HEADER + U32);
    return stub;
  }

  /** Insert a row, maintaining the primary index and every secondary index. */
  insertRow(tx: Tx, table: TableMeta, rowid: bigint, values: Value[]): Rid {
    if (!this.hasRowId(table)) {
      throw new ExecutionError(`system table "${table.name}" is read-only`);
    }
    const rid = this.heap.insert(tx, table.heapRoot, this.encodeRecord(tx, table, rowid, values));
    BTree.insert(tx, table.pkRoot, rowid, rid);
    for (const index of this.catalog.getIndexes(table.name)) {
      const key = values[columnIndex(table.schema, index.columnName)]!;
      if (key !== null) BTree.insert(tx, index.root, key as bigint, rid); // INT-only indexes
    }
    return rid;
  }

  /**
   * Replace a row's values, keeping its rowid. If the new heap record is the same
   * byte length it is overwritten in place (rid — and every index entry pointing
   * at it — stays valid, only changed index keys re-pointed); otherwise the row
   * is relocated and all indexes re-pointed to the new rid. Returns the new rid.
   * A relocated or re-spilled overflow chain is left in place (no reclamation yet).
   */
  updateRow(tx: Tx, table: TableMeta, row: ScannedRow, newValues: Value[]): Rid {
    if (!this.hasRowId(table)) {
      throw new ExecutionError(`system table "${table.name}" is read-only`);
    }
    const record = this.encodeRecord(tx, table, row.rowid, newValues);
    const indexes = this.catalog.getIndexes(table.name);
    const current = this.heap.get(tx, row.rid);

    if (current.length === record.length) {
      this.heap.overwrite(tx, row.rid, record);
      for (const index of indexes) {
        const col = columnIndex(table.schema, index.columnName);
        const oldKey = row.values[col]!;
        const newKey = newValues[col]!;
        if (oldKey === newKey) continue;
        if (oldKey !== null) BTree.delete(tx, index.root, oldKey as bigint, row.rid);
        if (newKey !== null) BTree.insert(tx, index.root, newKey as bigint, row.rid);
      }
      return row.rid;
    }

    this.heap.delete(tx, row.rid);
    const newRid = this.heap.insert(tx, table.heapRoot, record);
    BTree.delete(tx, table.pkRoot, row.rowid, row.rid);
    BTree.insert(tx, table.pkRoot, row.rowid, newRid);
    for (const index of indexes) {
      const col = columnIndex(table.schema, index.columnName);
      const oldKey = row.values[col]!;
      const newKey = newValues[col]!;
      if (oldKey !== null) BTree.delete(tx, index.root, oldKey as bigint, row.rid);
      if (newKey !== null) BTree.insert(tx, index.root, newKey as bigint, newRid);
    }
    return newRid;
  }

  /** Tombstone a row and remove it from the primary and secondary indexes. */
  deleteRow(tx: Tx, table: TableMeta, row: ScannedRow): void {
    if (!this.hasRowId(table)) {
      throw new ExecutionError(`system table "${table.name}" is read-only`);
    }
    this.heap.delete(tx, row.rid);
    BTree.delete(tx, table.pkRoot, row.rowid, row.rid);
    for (const index of this.catalog.getIndexes(table.name)) {
      const key = row.values[columnIndex(table.schema, index.columnName)]!;
      if (key !== null) BTree.delete(tx, index.root, key as bigint, row.rid);
    }
  }

  /** Sequentially scan every live row in the table's heap. */
  *scan(tx: Tx, table: TableMeta): Generator<ScannedRow> {
    const withRowId = this.hasRowId(table);
    for (const rec of this.heap.scan(tx, table.heapRoot)) {
      yield this.decode(tx, table, rec.rid, rec.bytes, withRowId);
    }
  }

  /** Resolve a single rid (e.g. from an index lookup) to a row. */
  getRow(tx: Tx, table: TableMeta, rid: Rid): ScannedRow {
    return this.decode(tx, table, rid, this.heap.get(tx, rid), this.hasRowId(table));
  }

  private decode(tx: Tx, table: TableMeta, rid: Rid, bytes: Buffer, withRowId: boolean): ScannedRow {
    if (!withRowId) {
      return { rowid: 0n, rid, values: deserialize(table.schema, bytes) };
    }
    const rowid = bytes.readBigInt64LE(0);
    const kind = bytes.readUInt8(I64);
    let tupleBytes: Buffer;
    if (kind === INLINE) {
      tupleBytes = bytes.subarray(HEADER);
    } else {
      const firstPage = bytes.readUInt32LE(HEADER);
      const totalLen = bytes.readUInt32LE(HEADER + U32);
      tupleBytes = readOverflow(tx, firstPage, totalLen);
    }
    return { rowid, rid, values: deserialize(table.schema, tupleBytes) };
  }
}
