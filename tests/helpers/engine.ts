import {
  DEFAULT_MAX_SORT_ROWS,
  RowIdAllocator,
  type ExecContext,
} from "../../src/exec/context.js";
import { Executor, type QueryResult } from "../../src/exec/executor.js";
import { TableStore } from "../../src/exec/table-store.js";
import { Catalog } from "../../src/record/catalog.js";
import { BufferPool } from "../../src/storage/bufferpool.js";
import { Heap } from "../../src/storage/heap.js";
import { Pager } from "../../src/storage/pager.js";
import { DirectTx } from "../../src/storage/tx.js";
import { parse } from "../../src/sql/parser.js";
import { makeTempDb, type TempDb } from "./tmp.js";

/**
 * A minimal SQL engine over a non-logging DirectTx stack — enough to exercise
 * the planner/executor end to end before the WAL-backed Database facade exists.
 */
export interface TestEngine {
  readonly tmp: TempDb;
  exec(sql: string): QueryResult;
  /** Convenience for SELECTs: returns just the rows. */
  query(sql: string): import("../../src/record/schema.js").Value[][];
  flushClose(): void;
  reopen(): TestEngine;
  cleanup(): void;
}

export function makeEngine(tmp: TempDb = makeTempDb(), poolSize = 64): TestEngine {
  const pager = Pager.open(tmp.path);
  const pool = new BufferPool(pager, poolSize);
  const tx = new DirectTx(pool);
  const heap = new Heap();
  const fresh = pager.getCatalogRoot() === 0;
  const catalog = Catalog.open(tx, pager, heap);
  if (fresh) {
    pool.flushAll();
    pager.setCatalogRoot(catalog.rootPage());
  }
  const ctx: ExecContext = {
    tx,
    catalog,
    store: new TableStore(catalog, heap),
    rowids: new RowIdAllocator(),
    maxSortRows: DEFAULT_MAX_SORT_ROWS,
  };
  const executor = new Executor(ctx, catalog);

  return {
    tmp,
    exec(sql) {
      return executor.run(parse(sql));
    },
    query(sql) {
      const r = executor.run(parse(sql));
      if (r.type !== "select") throw new Error(`expected SELECT, got ${r.type}`);
      return r.rows;
    },
    flushClose() {
      pool.flushAll();
      pager.close();
    },
    reopen() {
      pool.flushAll();
      pager.close();
      return makeEngine(tmp, poolSize);
    },
    cleanup() {
      tmp.cleanup();
    },
  };
}
