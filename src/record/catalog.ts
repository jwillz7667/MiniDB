import { INVALID_PAGE } from "../constants.js";
import { CatalogError } from "../errors.js";
import { BTree } from "../storage/btree.js";
import type { Heap } from "../storage/heap.js";
import type { Pager } from "../storage/pager.js";
import type { Tx } from "../storage/tx.js";
import {
  type Column,
  type Schema,
  type Value,
  makeSchema,
  typeFromTag,
  typeTag,
} from "./schema.js";
import { deserialize, serialize } from "./tuple.js";

/** Resolved metadata for one table held in memory for fast planning. */
export interface TableMeta {
  readonly name: string;
  readonly heapRoot: number;
  /** Root of the rowid -> rid primary index. 0 for the system tables. */
  readonly pkRoot: number;
  readonly columns: Column[];
  readonly schema: Schema;
}

/** A secondary B+Tree index on a single INT column. */
export interface IndexMeta {
  readonly tableName: string;
  readonly columnName: string;
  readonly root: number;
}

const TABLES = "minidb_tables";
const COLUMNS = "minidb_columns";
const INDEXES = "minidb_indexes";

/** Hardcoded shapes of the system tables (so the catalog can read itself). */
const TABLES_SCHEMA = makeSchema([
  { name: "table_name", type: "TEXT", nullable: false },
  { name: "heap_root", type: "INT", nullable: false },
  { name: "pk_root", type: "INT", nullable: false },
]);
const COLUMNS_SCHEMA = makeSchema([
  { name: "table_name", type: "TEXT", nullable: false },
  { name: "col_name", type: "TEXT", nullable: false },
  { name: "type_tag", type: "INT", nullable: false },
  { name: "ordinal", type: "INT", nullable: false },
  { name: "nullable", type: "BOOL", nullable: false },
]);
const INDEXES_SCHEMA = makeSchema([
  { name: "table_name", type: "TEXT", nullable: false },
  { name: "col_name", type: "TEXT", nullable: false },
  { name: "root", type: "INT", nullable: false },
]);

const SYSTEM_SCHEMAS: Record<string, Schema> = {
  [TABLES]: TABLES_SCHEMA,
  [COLUMNS]: COLUMNS_SCHEMA,
  [INDEXES]: INDEXES_SCHEMA,
};

function isSystemTable(name: string): boolean {
  return name === TABLES || name === COLUMNS || name === INDEXES;
}

/**
 * The catalog: the database describing itself in ordinary heaps. `minidb_tables`
 * lists every table's heap and primary-index roots; `minidb_columns` lists user
 * columns; `minidb_indexes` lists secondary indexes. The whole catalog is small,
 * so it is loaded into memory on open and written through on DDL.
 */
export class Catalog {
  private readonly tables = new Map<string, TableMeta>(); // key: lowercased name
  private readonly indexes: IndexMeta[] = [];

  private constructor(
    private readonly heap: Heap,
    private readonly tablesRoot: number,
    private readonly columnsRoot: number,
    private readonly indexesRoot: number,
  ) {}

  static open(tx: Tx, pager: Pager, heap: Heap): Catalog {
    const existingRoot = pager.getCatalogRoot();
    return existingRoot === INVALID_PAGE
      ? Catalog.bootstrap(tx, heap)
      : Catalog.load(tx, heap, existingRoot);
  }

  /**
   * Heap root of minidb_tables. After a fresh bootstrap the CALLER persists this
   * into the header via `pager.setCatalogRoot` — but only AFTER flushing the
   * catalog pages, so the header pointer never reaches disk before the pages it
   * references (which would leave the database permanently unopenable).
   */
  rootPage(): number {
    return this.tablesRoot;
  }

  private static bootstrap(tx: Tx, heap: Heap): Catalog {
    const tablesRoot = heap.create(tx);
    const columnsRoot = heap.create(tx);
    const indexesRoot = heap.create(tx);

    const cat = new Catalog(heap, tablesRoot, columnsRoot, indexesRoot);
    cat.writeTableRow(tx, TABLES, tablesRoot, INVALID_PAGE);
    cat.writeTableRow(tx, COLUMNS, columnsRoot, INVALID_PAGE);
    cat.writeTableRow(tx, INDEXES, indexesRoot, INVALID_PAGE);
    cat.registerSystemTables();
    return cat;
  }

  private static load(tx: Tx, heap: Heap, tablesRoot: number): Catalog {
    // Pass 1: read minidb_tables to discover the other system heaps' roots.
    const tableRows = [...heap.scan(tx, tablesRoot)].map((r) => deserialize(TABLES_SCHEMA, r.bytes));
    const rootOf = (name: string): number => {
      const row = tableRows.find((r) => r[0] === name);
      if (!row) throw new CatalogError(`catalog corrupt: missing system table ${name}`);
      return Number(row[1] as bigint);
    };
    const columnsRoot = rootOf(COLUMNS);
    const indexesRoot = rootOf(INDEXES);
    const cat = new Catalog(heap, tablesRoot, columnsRoot, indexesRoot);

    // Pass 2: group user columns by table.
    const columnsByTable = new Map<string, { ordinal: number; column: Column }[]>();
    for (const rec of heap.scan(tx, columnsRoot)) {
      const [tableName, colName, tag, ordinal, nullable] = deserialize(COLUMNS_SCHEMA, rec.bytes);
      const list = columnsByTable.get(tableName as string) ?? [];
      list.push({
        ordinal: Number(ordinal as bigint),
        column: {
          name: colName as string,
          type: typeFromTag(Number(tag as bigint)),
          nullable: nullable as boolean,
        },
      });
      columnsByTable.set(tableName as string, list);
    }

    // Pass 3: assemble every table's metadata.
    for (const row of tableRows) {
      const name = row[0] as string;
      const heapRoot = Number(row[1] as bigint);
      const pkRoot = Number(row[2] as bigint);
      const columns = isSystemTable(name)
        ? [...SYSTEM_SCHEMAS[name]!.columns]
        : (columnsByTable.get(name) ?? [])
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((c) => c.column);
      cat.tables.set(name.toLowerCase(), {
        name,
        heapRoot,
        pkRoot,
        columns,
        schema: makeSchema(columns),
      });
    }

    // Pass 4: secondary indexes.
    for (const rec of heap.scan(tx, indexesRoot)) {
      const [tableName, colName, root] = deserialize(INDEXES_SCHEMA, rec.bytes);
      cat.indexes.push({
        tableName: tableName as string,
        columnName: colName as string,
        root: Number(root as bigint),
      });
    }

    return cat;
  }

  private registerSystemTables(): void {
    const def = (name: string, heapRoot: number): void => {
      const columns = [...SYSTEM_SCHEMAS[name]!.columns];
      this.tables.set(name.toLowerCase(), {
        name,
        heapRoot,
        pkRoot: INVALID_PAGE,
        columns,
        schema: makeSchema(columns),
      });
    };
    def(TABLES, this.tablesRoot);
    def(COLUMNS, this.columnsRoot);
    def(INDEXES, this.indexesRoot);
  }

  private writeTableRow(tx: Tx, name: string, heapRoot: number, pkRoot: number): void {
    const row: Value[] = [name, BigInt(heapRoot), BigInt(pkRoot)];
    this.heap.insert(tx, this.tablesRoot, serialize(TABLES_SCHEMA, row));
  }

  /** Create a user table: allocate its heap + primary index and record metadata. */
  createTable(tx: Tx, name: string, columns: Column[]): TableMeta {
    if (isSystemTable(name) || name.toLowerCase().startsWith("minidb_")) {
      throw new CatalogError(`"${name}" uses the reserved minidb_ prefix`);
    }
    if (this.tables.has(name.toLowerCase())) {
      throw new CatalogError(`table "${name}" already exists`);
    }
    if (columns.length === 0) throw new CatalogError(`table "${name}" needs at least one column`);
    // Validate the column list (duplicate names, etc.) BEFORE writing anything,
    // so a bad definition never leaves half-written catalog rows behind.
    const schema = makeSchema(columns);

    const heapRoot = this.heap.create(tx);
    const pkRoot = BTree.create(tx);
    this.writeTableRow(tx, name, heapRoot, pkRoot);
    columns.forEach((col, ordinal) => {
      const row: Value[] = [
        name,
        col.name,
        BigInt(typeTag(col.type)),
        BigInt(ordinal),
        col.nullable,
      ];
      this.heap.insert(tx, this.columnsRoot, serialize(COLUMNS_SCHEMA, row));
    });

    const meta: TableMeta = { name, heapRoot, pkRoot, columns, schema };
    this.tables.set(name.toLowerCase(), meta);
    return meta;
  }

  /** Record a secondary index (its B+Tree must already be built/populated). */
  createIndex(tx: Tx, tableName: string, columnName: string, root: number): IndexMeta {
    const table = this.requireTable(tableName);
    if (!table.columns.some((c) => c.name.toLowerCase() === columnName.toLowerCase())) {
      throw new CatalogError(`column "${columnName}" does not exist on "${tableName}"`);
    }
    if (this.findIndex(tableName, columnName)) {
      throw new CatalogError(`an index on ${tableName}(${columnName}) already exists`);
    }
    const row: Value[] = [table.name, columnName, BigInt(root)];
    this.heap.insert(tx, this.indexesRoot, serialize(INDEXES_SCHEMA, row));
    const meta: IndexMeta = { tableName: table.name, columnName, root };
    this.indexes.push(meta);
    return meta;
  }

  getTable(name: string): TableMeta | undefined {
    return this.tables.get(name.toLowerCase());
  }

  requireTable(name: string): TableMeta {
    const meta = this.getTable(name);
    if (!meta) throw new CatalogError(`no such table: ${name}`);
    return meta;
  }

  listTables(includeSystem = false): TableMeta[] {
    return [...this.tables.values()].filter((t) => includeSystem || !isSystemTable(t.name));
  }

  getIndexes(tableName: string): IndexMeta[] {
    return this.indexes.filter((i) => i.tableName.toLowerCase() === tableName.toLowerCase());
  }

  findIndex(tableName: string, columnName: string): IndexMeta | undefined {
    return this.indexes.find(
      (i) =>
        i.tableName.toLowerCase() === tableName.toLowerCase() &&
        i.columnName.toLowerCase() === columnName.toLowerCase(),
    );
  }
}
