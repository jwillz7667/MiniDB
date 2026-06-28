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
