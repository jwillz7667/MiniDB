import { I64, INVALID_PAGE } from "../constants.js";
import { ExecutionError } from "../errors.js";
import type { Catalog, TableMeta } from "../record/catalog.js";
import { columnIndex, type Value } from "../record/schema.js";
import { deserialize, serialize } from "../record/tuple.js";
import { BTree } from "../storage/btree.js";
import type { Heap } from "../storage/heap.js";
import type { Rid } from "../storage/rid.js";
import type { Tx } from "../storage/tx.js";

/** A row materialized from the heap, with its internal rowid and physical rid. */
export interface ScannedRow {
  readonly rowid: bigint;
  readonly rid: Rid;
  readonly values: Value[];
}

/**
 * The bridge between logical rows and physical storage for a single table.
 * Every user row is stored as an 8-byte rowid prefix followed by its serialized
 * tuple; the rowid is the primary B+Tree key and lets DELETE maintain the
 * indexes. System tables (pkRoot === INVALID_PAGE) carry no rowid prefix and are
 * read-only through this store.
 */
export class TableStore {
  constructor(
    private readonly catalog: Catalog,
    private readonly heap: Heap,
  ) {}

  private hasRowId(table: TableMeta): boolean {
    return table.pkRoot !== INVALID_PAGE;
  }

  /** Insert a row, maintaining the primary index and every secondary index. */
  insertRow(tx: Tx, table: TableMeta, rowid: bigint, values: Value[]): Rid {
    if (!this.hasRowId(table)) {
      throw new ExecutionError(`system table "${table.name}" is read-only`);
    }
    const tuple = serialize(table.schema, values);
    const bytes = Buffer.alloc(I64 + tuple.length);
    bytes.writeBigInt64LE(rowid, 0);
    tuple.copy(bytes, I64);

    const rid = this.heap.insert(tx, table.heapRoot, bytes);
    BTree.insert(tx, table.pkRoot, rowid, rid);
    for (const index of this.catalog.getIndexes(table.name)) {
      const key = values[columnIndex(table.schema, index.columnName)]!;
      if (key !== null) BTree.insert(tx, index.root, key as bigint, rid); // INT-only indexes
    }
    return rid;
  }

  /**
   * Replace a row's values, keeping its rowid. If the new tuple serializes to
   * the same byte length it is overwritten in place, so the rid — and every
   * index entry that points at it — stays valid and only changed index keys are
   * re-pointed. Otherwise the record is relocated (delete + re-insert at a new
   * rid) and all indexes are re-pointed to the new rid. Returns the new rid.
   */
  updateRow(tx: Tx, table: TableMeta, row: ScannedRow, newValues: Value[]): Rid {
    if (!this.hasRowId(table)) {
      throw new ExecutionError(`system table "${table.name}" is read-only`);
    }
    const tuple = serialize(table.schema, newValues); // validates types + NOT NULL
    const bytes = Buffer.alloc(I64 + tuple.length);
    bytes.writeBigInt64LE(row.rowid, 0);
    tuple.copy(bytes, I64);

    const indexes = this.catalog.getIndexes(table.name);
    const current = this.heap.get(tx, row.rid);

    if (current.length === bytes.length) {
      this.heap.overwrite(tx, row.rid, bytes);
      // Only re-point indexes whose key actually changed; the rid is unchanged.
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

    // Length changed: relocate. Tombstone the old record and append a new one,
    // then move the primary and every secondary index entry to the new rid.
    this.heap.delete(tx, row.rid);
    const newRid = this.heap.insert(tx, table.heapRoot, bytes);
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
      yield this.decode(table, rec.rid, rec.bytes, withRowId);
    }
  }

  /** Resolve a single rid (e.g. from an index lookup) to a row. */
  getRow(tx: Tx, table: TableMeta, rid: Rid): ScannedRow {
    return this.decode(table, rid, this.heap.get(tx, rid), this.hasRowId(table));
  }

  private decode(table: TableMeta, rid: Rid, bytes: Buffer, withRowId: boolean): ScannedRow {
    if (withRowId) {
      return {
        rowid: bytes.readBigInt64LE(0),
        rid,
        values: deserialize(table.schema, bytes.subarray(I64)),
      };
    }
    return { rowid: 0n, rid, values: deserialize(table.schema, bytes) };
  }
}
