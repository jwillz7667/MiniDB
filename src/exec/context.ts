import type { Catalog, TableMeta } from "../record/catalog.js";
import { BTree } from "../storage/btree.js";
import type { Tx } from "../storage/tx.js";
import type { TableStore } from "./table-store.js";

/**
 * Hands out monotonically increasing rowids per table. The next id is seeded
 * lazily from the largest key already in the table's primary index, so ids are
 * never reused across a reopen (deleted ids are simply skipped).
 */
export class RowIdAllocator {
  private readonly next = new Map<number, bigint>(); // keyed by pk root page

  allocate(tx: Tx, table: TableMeta): bigint {
    let id = this.next.get(table.pkRoot);
    if (id === undefined) {
      const max = BTree.maxKey(tx, table.pkRoot);
      id = (max ?? 0n) + 1n;
    }
    this.next.set(table.pkRoot, id + 1n);
    return id;
  }

  /** Drop cached counters (e.g. after a rollback that undid inserts). */
  reset(): void {
    this.next.clear();
  }
}

/** Everything an operator needs to touch storage during execution. */
export interface ExecContext {
  readonly tx: Tx;
  readonly catalog: Catalog;
  readonly store: TableStore;
  readonly rowids: RowIdAllocator;
  /** Max rows an unbounded (no-LIMIT) Sort may buffer before failing safe. */
  readonly maxSortRows: number;
}

/** Default cap for an unbounded in-memory sort. */
export const DEFAULT_MAX_SORT_ROWS = 1_000_000;
