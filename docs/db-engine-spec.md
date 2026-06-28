# minidb — a SQL database engine from scratch in TypeScript

A build-ready spec for Claude Code. The goal is a real, durable, single-file SQL database with a B+Tree storage engine, a write-ahead log, a query executor, and transactions. Not a toy. The point is to be able to kill the process mid-write, restart, and have consistent data.

This doc is the source of truth. Build it in phases. Every phase ends with a working, tested, demoable artifact. Do not skip the tests.

---

## 0. Ground rules (read this first)

- **Language:** TypeScript, strict mode. Node 20+.
- **Package manager:** pnpm.
- **Test runner:** Vitest. Every phase ships with tests. No phase is "done" until its tests pass.
- **No external DB/storage libraries.** The whole point is that we wrote the storage layer ourselves. `Buffer` and `DataView` for byte work. That's it. (Allowed: a CLI helper lib for the REPL, and `vitest`.)
- **Single data file.** The entire database lives in one file made of fixed-size pages, like SQLite. Plus one WAL file.
- **Page size:** 4096 bytes. Define it once as a constant and never hardcode the number anywhere else.
- **Style:** small files, one responsibility each. Pure functions where possible. Errors are thrown as typed error classes, not returned as null.

### Repo layout

```
minidb/
  package.json
  tsconfig.json            # strict: true, target ES2022, module NodeNext
  vitest.config.ts
  src/
    constants.ts           # PAGE_SIZE, magic numbers, type tags
    errors.ts              # typed error classes
    storage/
      pager.ts             # read/write/allocate raw pages on disk
      bufferpool.ts        # page cache, pin/unpin, dirty tracking, clock eviction
      page.ts              # page header helpers, slotted-page layout
      btree.ts             # on-disk B+Tree (insert, search, range scan, splits)
    record/
      schema.ts            # column types, table schema definition
      tuple.ts             # serialize/deserialize a row to/from bytes
      catalog.ts           # system tables describing user tables
    sql/
      lexer.ts             # source string -> tokens
      token.ts             # token types
      parser.ts            # tokens -> AST (recursive descent)
      ast.ts               # AST node types
    plan/
      logical.ts           # AST -> logical plan
      optimizer.ts         # rewrite rules (index selection, predicate pushdown)
      physical.ts          # logical plan -> physical operators
    exec/
      operators.ts         # Volcano operators: SeqScan, IndexScan, Filter, etc.
      executor.ts          # drives the operator tree, returns rows
    txn/
      wal.ts               # write-ahead log: append, flush, replay
      recovery.ts          # redo/undo on startup
      transaction.ts       # MVCC: versions, snapshots, begin/commit/rollback
    db.ts                  # top-level Database class tying it together
    repl.ts                # interactive CLI
    bench/
      bench.ts             # throughput + latency benchmarks
  tests/
    ... mirror src/ ...
  README.md
```

### Byte-layout conventions (use everywhere)

- All multi-byte integers are **little-endian**.
- Page numbers are unsigned 32-bit ints. Page 0 is reserved for the database header.
- Offsets within a page are unsigned 16-bit ints (a page is 4096 bytes, fits in 16 bits).
- Strings are length-prefixed: u16 length, then UTF-8 bytes.
- "Null" in a tuple is tracked by a null-bitmap at the front of the tuple, one bit per column.

---

## Phase 1 — Pager + buffer pool

**What it does:** turns one file on disk into a sequence of fixed-size pages, and caches them in memory so we're not hitting disk on every access.

### Pager (`storage/pager.ts`)
- Opens (or creates) the data file.
- `readPage(pageNo): Buffer` — reads 4096 bytes at offset `pageNo * PAGE_SIZE`.
- `writePage(pageNo, buf): void` — writes 4096 bytes at that offset, then `fsync` so it actually hits disk.
- `allocatePage(): number` — grows the file by one page, returns the new page number.
- `pageCount(): number` — file size / PAGE_SIZE.
- Page 0 holds a header: a 4-byte magic string (`"MNDB"`), a u16 page size, a u32 page count, and the root page number of the catalog. Write it on first creation, validate it on open (wrong magic = throw, not a minidb file).

### Buffer pool (`storage/bufferpool.ts`)
- Fixed capacity (e.g. 128 frames, configurable). A frame holds one cached page.
- `fetchPage(pageNo)` — returns the cached page, loading from the pager on a miss. Increments a pin count.
- `unpin(pageNo, isDirty)` — decrements pin count, marks dirty if the caller wrote to it.
- `flushPage(pageNo)` / `flushAll()` — write dirty pages back through the pager.
- **Eviction: clock algorithm.** Each frame has a reference bit. On a miss with a full pool, sweep a clock hand: if ref bit set, clear it and advance; if clear and pin count is 0, evict that frame (flush if dirty). Never evict a pinned page. If every page is pinned, throw (pool too small).
- Track and expose a hit-rate counter. You'll quote this number in your README.

### Acceptance criteria (tests)
- Allocate a page, write a known byte pattern, evict it (fill the pool past capacity), read it back, bytes match.
- Pinned pages are never evicted.
- Hit-rate counter increments correctly on hits vs misses.
- Reopen the file in a new process/instance, header validates, data persists.

### Demo at end of phase
A script that writes 10,000 pages, reports the buffer pool hit rate under a hot-vs-cold access pattern.

---

## Phase 2 — B+Tree

**What it does:** an ordered, on-disk index. Keys map to values. This is what makes lookups and range queries fast instead of full scans.

### `storage/btree.ts`
- Two node types living in pages: **internal** nodes (keys + child page pointers) and **leaf** nodes (keys + values, plus a pointer to the next leaf for range scans).
- Node page layout: a 1-byte type tag (leaf/internal), u16 key count, then the entries. Leaves end with a u32 "next leaf" page pointer.
- Keys for now: 8-byte signed integers (we'll key tables by an integer row id / primary key). Values in a leaf: a u32 page number + u16 slot, i.e. a pointer to where the actual row lives (see Phase 3). This keeps the tree small.
- `insert(key, value)` — descend to the correct leaf; if it has room, insert in sorted order; if full, **split** the leaf, push the median key up to the parent, and recurse the split upward, creating a new root if the old root splits.
- `search(key)` — descend to the leaf, binary-search within it.
- `rangeScan(lo, hi)` — find the leaf containing `lo`, then walk the next-leaf pointers yielding entries until you pass `hi`. This is why B+Trees beat hashmaps: ordered range scans are basically free.
- **Deletion:** implement tombstone deletion (mark the entry deleted, leave the slot). Skip merge/rebalance on delete for now and note it as a known limitation in the README. Real databases defer this work too (vacuum/compaction). Don't sink a week into B+Tree rebalancing.

### Acceptance criteria (tests)
- Insert 100,000 sequential keys, then 100,000 random keys; every key is findable; an in-order scan returns them sorted.
- Force splits (insert enough to exceed leaf capacity), verify tree height grew and the root changed.
- Range scan returns exactly the keys in `[lo, hi]`, in order.
- Persist and reopen: the tree is intact.

---

## Phase 3 — Records, slotted pages, catalog

**What it does:** lets us store actual rows of typed data, and lets the database describe its own tables.

### Slotted page (`storage/page.ts`)
- A page that stores variable-length records. Layout: header (record count, free-space pointer), then a **slot array** growing from the front (each slot = u16 offset + u16 length), and the **record data** growing from the back. Insert puts data at the back, adds a slot at the front. This is the standard heap-page layout.
- `insertRecord(bytes): slotIndex`, `getRecord(slotIndex): bytes`, `deleteRecord(slotIndex)` (tombstone the slot).

### Schema + tuple (`record/schema.ts`, `record/tuple.ts`)
- Column types: `INT` (8-byte), `TEXT` (length-prefixed UTF-8), `BOOL` (1 byte). That's enough to be real; add `FLOAT` later if you want.
- A `Schema` is an ordered list of `{ name, type, nullable }`.
- `serialize(schema, row): Buffer` — null-bitmap first, then each non-null column packed by type.
- `deserialize(schema, buf): row` — inverse.

### Catalog (`record/catalog.ts`)
- The database describes itself in system tables stored like any other table.
- `minidb_tables`: table name, root page of its heap, root page of its primary-key B+Tree.
- `minidb_columns`: table name, column name, type, ordinal position, nullable.
- On `CREATE TABLE`, allocate a heap page + a B+Tree root, write rows into the catalog. On open, read the catalog to know what tables exist.

### Acceptance criteria (tests)
- Round-trip every column type through serialize/deserialize, including nulls.
- Slotted page packs multiple variable-length records, retrieves each correctly, survives deletes.
- Create a table, reopen the DB, the catalog reports it with the right columns.

---

## Phase 4 — SQL frontend (lexer + parser)

**What it does:** turns a SQL string into a structured AST. Hand-written, no parser generator. The grammar below is the target subset.

### Supported grammar (v1)
```
CREATE TABLE name (col type [NOT NULL], ...)
INSERT INTO name (col, ...) VALUES (val, ...)
SELECT col, ... | *  FROM name
  [WHERE expr]
  [ORDER BY col [ASC|DESC]]
  [LIMIT n]
DELETE FROM name [WHERE expr]
CREATE INDEX ON name (col)            -- builds a secondary B+Tree

expr := col op literal | expr AND expr | expr OR expr | ( expr )
op   := = | != | < | <= | > | >=
```
JOINs come in Phase 5's stretch goal. Get the above rock-solid first.

### Lexer (`sql/lexer.ts`)
- Produces tokens: keywords, identifiers, integer literals, string literals (single-quoted), operators, punctuation. Case-insensitive keywords. Skip whitespace. Throw a clear error with position on an unexpected character.

### Parser (`sql/parser.ts`)
- **Recursive descent.** One method per grammar rule (`parseSelect`, `parseInsert`, `parseExpr`, etc.). Expression parsing handles `AND`/`OR` precedence (AND binds tighter than OR) and parentheses.
- Output is typed AST nodes (`ast.ts`).
- Errors name what was expected and what was found.

### Acceptance criteria (tests)
- Parse one valid example of every statement type into the expected AST.
- `WHERE a = 1 AND b > 2 OR c = 3` parses with correct precedence.
- Malformed SQL throws a readable error pointing at the bad token.

---

## Phase 5 — Planner + executor (Volcano model)

**What it does:** turns the AST into a tree of operators that pull rows from each other one at a time. This is the canonical "iterator / Volcano" execution model and it's exactly what interviewers want you to be able to explain.

### Operators (`exec/operators.ts`)
Every operator implements the same interface:
```
interface Operator {
  open(): void
  next(): Row | null   // null = end of stream
  close(): void
}
```
Implement:
- `SeqScan` — walks every record in a table's heap pages.
- `IndexScan` — uses a B+Tree to fetch only matching row pointers, then loads those rows. Used when a WHERE predicate hits an indexed column with `=` or a range.
- `Filter` — wraps a child, drops rows that fail the WHERE expression.
- `Project` — selects/reorders columns.
- `Sort` — buffers child rows, sorts (for ORDER BY). In-memory is fine for v1.
- `Limit` — stops after N rows.
- `Insert` / `Delete` — write operators that update the heap and any indexes.
- (Stretch) `NestedLoopJoin`, then `HashJoin` — enables the JOIN grammar.

### Planner (`plan/`)
- `logical.ts`: AST → logical plan (a tree of logical nodes).
- `optimizer.ts`: two rewrite rules, and they should be visible/explainable:
  1. **Predicate pushdown** — push filters as close to the scan as possible.
  2. **Index selection** — if a WHERE column has a B+Tree index and uses `=` or a range, swap `SeqScan + Filter` for `IndexScan`.
- `physical.ts`: logical plan → concrete operator tree.
- Add an `EXPLAIN` path that prints the chosen operator tree. This is a great demo — you can *show* the optimizer choosing an index scan over a seq scan.

### Acceptance criteria (tests)
- End to end: `CREATE TABLE`, `INSERT` a few hundred rows, `SELECT * WHERE ... ORDER BY ... LIMIT ...` returns the correct rows in the correct order.
- With an index present, `EXPLAIN` shows `IndexScan`; without it, `SeqScan`. Both return identical results.
- `DELETE WHERE` removes the right rows and updates the index.

### Demo at end of phase
The REPL now runs real SQL. You can create a table, load data, and query it. This is already a portfolio-worthy project. Phases 6 and 7 are what make it a knockout.

---

## Phase 6 — Write-ahead log + crash recovery (the mic-drop)

**What it does:** guarantees that committed data survives a crash, and a crash never leaves the database half-written and corrupt. This single phase is worth more in an interview than everything above it, because almost nobody builds it.

### WAL (`txn/wal.ts`)
- Separate append-only log file.
- **Write-ahead rule:** before any change to a page is flushed to the data file, the log record describing that change must already be on disk (`fsync`'d). This is the entire ballgame for durability.
- Log record types: `BEGIN`, `UPDATE` (page number, offset, before-image, after-image), `COMMIT`, `ABORT`, `CHECKPOINT`. Each record has a monotonically increasing LSN (log sequence number).
- `append(record): lsn`, `flush(uptoLsn)`.

### Recovery (`txn/recovery.ts`) — ARIES-lite
- On startup, replay the log:
  1. **Analysis:** scan the log, find which transactions committed and which didn't.
  2. **Redo:** re-apply every logged change (committed or not) to bring pages up to the log's state.
  3. **Undo:** roll back changes from transactions that never committed, using before-images.
- **Checkpointing:** periodically write a CHECKPOINT record and flush dirty pages, so recovery doesn't replay the entire log from the beginning of time. Recovery starts from the last checkpoint.

### Acceptance criteria (tests) — these are the good ones
- Begin a transaction, write rows, **simulate a crash** (drop the buffer pool without flushing, then run recovery from the WAL). Committed rows are present; uncommitted rows are gone.
- A torn write mid-transaction (kill after some pages but before COMMIT) recovers to the last consistent state, no corruption.
- Checkpoint, then crash after it: recovery only replays from the checkpoint forward.

### Demo at end of phase
A script (or a literal `kill -9` in a recorded terminal session) that crashes the process mid-write and shows the database coming back clean on restart. **Record this with asciinema.** It goes at the top of your README.

---

## Phase 7 — Transactions / MVCC (the senior flex, optional)

**What it does:** lets multiple transactions run concurrently with snapshot isolation, so a reader never sees a writer's half-finished work and never blocks on it.

### `txn/transaction.ts`
- **MVCC:** each row version carries `xmin` (the transaction id that created it) and `xmax` (the transaction id that deleted/superseded it). An UPDATE writes a new version and sets `xmax` on the old one; it doesn't overwrite in place.
- A transaction gets a **snapshot** at start: the set of transaction ids it should consider visible. A row version is visible if its `xmin` is committed-and-visible and its `xmax` is not.
- `begin()` assigns a transaction id and snapshot. `commit()` marks the id committed. `rollback()` marks it aborted (its versions become invisible to everyone).
- Isolation level target: **snapshot isolation**. Document where it differs from serializable (write skew) — being able to name that tradeoff is itself the flex.

### Acceptance criteria (tests)
- Transaction A reads a row, Transaction B updates and commits, A re-reads and still sees the old value (snapshot isolation: no non-repeatable reads within A).
- Rollback makes a transaction's writes invisible to everyone.
- Concurrent inserts from two transactions both land without corrupting the heap or index.

> If you're time-boxed, ship through Phase 6 and write Phase 7 up as "planned / in progress." Phases 1–6 already kill the "shallow vibe coder" perception dead.

---

## Phase 8 — Polish for hiring

This is where the project converts into interview wins. Do not skip it.

- **Benchmarks (`bench/`):** measure and record real numbers. Inserts/sec, point-query latency (p50/p99), range-scan throughput, buffer pool hit rate, recovery time after a crash with N MB of WAL. Numbers signal rigor.
- **README that tells a story.** Lead with the crash-recovery demo gif/asciinema. Then a one-paragraph architecture overview (reuse the layer diagram). Then a section titled "the three hardest problems" — pick three real ones (e.g. B+Tree node splits, write-ahead ordering, MVCC visibility rules), explain the problem and your decision in plain language. This is what hiring managers actually read, and it's where you prove you understood the code rather than just generated it.
- **`EXPLAIN` output in the README** showing the optimizer picking an index scan. Cheap, looks impressive.
- **CI:** GitHub Actions running the full Vitest suite on every push. Green badge in the README.
- **A 90-second demo video or asciinema cast** at the top. Most people will watch that and read the README and never open the code; make those two things excellent.

---

## Suggested names

`minidb` is the working name and it's fine. If you want something with more character: **Pagefault**, **Slotted**, **Heapsmith**, **Tinybase** (taken, avoid), **Coregraph**. `Pagefault` is the strongest, it's a memory/storage pun that systems people will immediately get.

---

## How to drive this with Claude Code

Build one phase per session. For each phase: give Claude Code this spec plus "implement Phase N, including the tests in its acceptance criteria, and don't move on until they pass." Run the tests yourself between phases. When something breaks, paste the failing test output back in. Resist the urge to let it run all 8 phases unsupervised. The whole value of this project is that you can explain it in an interview, which means you need to actually read and understand each phase as it lands.

The order is load-bearing. You cannot build the executor before the B+Tree, or recovery before the WAL. Don't reorder.
