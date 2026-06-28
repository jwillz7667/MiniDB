# minidb

[![CI](https://github.com/jwillz7667/MiniDB/actions/workflows/ci.yml/badge.svg)](https://github.com/jwillz7667/MiniDB/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-95%25-brightgreen)](https://github.com/jwillz7667/MiniDB/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A **real, durable SQL database engine written from scratch in TypeScript** — a B+Tree
storage engine, a write-ahead log, ARIES-lite crash recovery, a Volcano query executor, and
MVCC snapshot isolation. No external database, storage, or parser libraries: every byte on
disk is laid out by code in this repo.

The bar this project sets for itself: **kill the process mid-write, restart, and read back
consistent, committed data.** That single property — and the WAL + recovery machinery behind
it — is what separates this from a toy.

```text
$ pnpm demo:crash

minidb crash-recovery demo

  committed 3 rows  ->  table holds 3 rows
  wrote 2 more rows inside an UNCOMMITTED transaction  ->  5 rows visible
  *** CRASH (process killed before COMMIT) ***

  reopened — replayed 1.8 KB WAL: redone 0, undone 10
  table now holds 3 rows (the committed 3; the uncommitted 2 were rolled back)
  rows: (1, 100), (2, 200), (3, 300)

  result: committed data survived, the crash left no corruption.
```

---

## Architecture

Everything lives in **one data file** of fixed-size 4 KB pages (plus one WAL file), like
SQLite. Dependencies flow strictly downward:

```text
        repl / bench / db (facade)
                  │
        exec   Volcano operators + executor (SeqScan, IndexScan, Filter,
                  │                            Project, Sort, Limit, Insert, Delete)
        plan   logical plan → optimizer → physical plan   (+ EXPLAIN)
                  │
        sql    lexer → recursive-descent parser → AST
                  │
        record schema · tuple (de)serialization · self-describing catalog
                  │
        storage  B+Tree   ·   slotted heap pages        txn  WAL · recovery · MVCC
                  │                                       │
        bufferpool  clock eviction · pin/dirty · write-ahead hook
                  │
        pager   raw 4 KB pages · fsync · file growth
```

The layering is enforced by discipline (and reflected in the import graph): the domain code
never reaches upward, and the access methods (heap, B+Tree) never know logging exists — they
mutate pages through a small `Tx` interface that a WAL-backed transaction journals
transparently.

### Capabilities

- **SQL**: `CREATE TABLE`, `CREATE INDEX`, `INSERT`, `SELECT … WHERE … ORDER BY … LIMIT`,
  `DELETE … WHERE`, `EXPLAIN`, and `BEGIN` / `COMMIT` / `ROLLBACK`.
- **Types**: `INT` (signed 64-bit, carried as `bigint` end-to-end so nothing is rounded),
  `TEXT` (length-prefixed UTF-8), `BOOL`. NULLs tracked by a per-tuple null bitmap.
- **Storage**: on-disk B+Tree (point lookups + ordered range scans), slotted heap pages,
  a buffer pool with clock (second-chance) eviction.
- **Durability**: write-ahead logging with the STEAL + NO-FORCE policy and ARIES-lite redo /
  undo recovery (with logged compensation records), checkpointing, and CRC32 on both log
  records and **every data page**, so torn writes and bit-rot are detected, not silently
  served. Configurable sync modes (`full` / `normal` / `off`) and a directory fsync on
  create.
- **Concurrency**: MVCC with snapshot isolation — versioned tuples (`xmin`/`xmax`), per-
  transaction snapshots, and first-updater-wins conflict detection. A PID lock keeps two
  instances from opening (and corrupting) the same file.
- **Resource safety**: `ORDER BY … LIMIT n` keeps only a bounded top-N; an unbounded
  `ORDER BY` is capped and fails safe instead of exhausting memory.
- **Optimizer**: predicate pushdown into the access method and index selection, both visible
  in `EXPLAIN`.

---

## Quick start

```bash
pnpm install
pnpm test          # 116 tests, incl. a crash-injection fuzzer
pnpm repl          # interactive SQL shell
```

```sql
minidb> CREATE TABLE users (id INT NOT NULL, name TEXT, age INT NOT NULL);
minidb> INSERT INTO users (id, name, age) VALUES (1, 'ann', 30), (2, 'bob', 25), (3, 'cara', 30);
minidb> CREATE INDEX ON users (age);
minidb> SELECT id, name FROM users WHERE age = 30 ORDER BY name;
+----+------+
| id | name |
+----+------+
| 1  | ann  |
| 3  | cara |
+----+------+
2 rows
```

### The optimizer, made visible

`EXPLAIN` prints the chosen operator tree. Add an index and watch a `SeqScan + Filter` become
an `IndexScan` with the indexed predicate pushed down and the rest left as a residual filter:

```text
$ pnpm demo:explain

Without an index — full scan:
    Project (id)
      Filter (age = 40 AND city = 'city2')
        SeqScan people

After CREATE INDEX ON people (age):
    Project (id)
      Filter city = 'city2'
        IndexScan people.age [40, 40]

Same results either way: yes
```

---

## The three hardest problems

The interesting parts of building a database aren't the SQL — they're the invariants that
have to hold when things go wrong. Three that took real thought here:

### 1. B+Tree node splits with a *stable* root

Splitting a full leaf and pushing a separator key up to the parent — recursively, creating a
new level when the root itself fills — is the classic B+Tree problem. Two decisions made it
tractable:

- **Composite `(key, rid)` ordering.** Secondary indexes have duplicate keys (many rows share
  a value). Rather than wrestle with equal keys straddling a split boundary, every entry is
  ordered by the pair `(key, rid)`. Because each row's rid is unique, *all* composite keys are
  unique, so splits never separate "equal" keys and a `col = X` lookup is just a range scan
  over `[(X, minRid) … (X, maxRid)]`. This is exactly how Postgres/InnoDB make non-unique
  indexes work.
- **A fixed root page.** Index roots are recorded in the catalog. If a root split allocated a
  new root page, every split would need a catalog write (and a window to get it wrong). So
  when the root splits, its contents are relocated to a fresh child and the *same* root page
  is rewritten as the new internal node. The root page number never changes — the catalog
  never has to.

### 2. Write-ahead ordering, and recovering from a steal

Durability is an ordering problem. The rule — *a page's log record must be on disk before the
page itself* — is enforced in one place: the buffer pool refuses to flush a dirty page until
the WAL has been fsync'd up to that page's `pageLSN`. That single hook lets the engine run
**STEAL** (evict uncommitted pages to make room) and **NO-FORCE** (don't flush on commit) — the
policies that make it fast — while staying recoverable.

Recovery is ARIES-lite: **analysis** finds committed and aborted transactions and the last
checkpoint, **redo** re-applies every logged after-image from the checkpoint forward
(rebuilding pages no-force left only in the log), and **undo** reverts before-images for *true
in-flight losers* — transactions with neither a COMMIT nor an ABORT. Rollback is itself logged:
it writes **compensation records** so redo reconstructs the rolled-back state, which means an
aborted transaction is never undone by the undo pass — undoing it would clobber whatever a
*later committed* transaction wrote to the same bytes (a subtle corruption an adversarial code
review caught and that the regression suite now guards). Page *allocation* is durable for free:
a logged change to a page past end-of-file grows the file first. Log records carry a CRC32, so a
torn trailing write from a real crash is simply ignored.

The engine is **single-writer** (like SQLite's WAL mode): at most one transaction mutates at a
time, so the only true in-flight loser after a crash is the final, unfinished transaction.

### 3. MVCC visibility rules

Snapshot isolation means a reader never blocks on a writer and never sees its half-finished
work. Each row version carries `xmin` (creator) and `xmax` (deleter); an UPDATE stamps `xmax`
on the old version and appends a new one instead of overwriting. A transaction takes a
**snapshot** at BEGIN — the set of transactions that had already committed — and a version is
visible iff its creator is committed-relative-to-that-snapshot and its deleter is not. The
subtle part is that a transaction which was *in flight* when your snapshot was taken stays
invisible to you even after it later commits; that's what prevents non-repeatable reads. The
tradeoff is documented honestly in the code: snapshot isolation permits **write skew**, which
serializable would not — catching it needs SSI, which this engine doesn't implement.

---

## Benchmarks

`pnpm bench` — measured on an Apple Silicon laptop, 50k rows. Numbers illustrate the engine's
shape (a from-scratch TypeScript engine with no native storage layer), not a contest with
production databases:

| Metric | Result |
| --- | --- |
| Bulk insert | ~19,000 rows/sec |
| Point query (indexed) | p50 **0.024 ms**, p99 0.041 ms (~40,000 q/sec) |
| Range scan | ~590,000 rows/sec |
| Buffer-pool hit rate (hot set) | 99.8% |
| Crash recovery | ~94 ms to replay a 7.9 MB WAL (30k rows restored) |

`pnpm demo:pool` exercises clock eviction directly: 10,000 pages (41 MB) through a 1,500-frame
pool (6 MB), 90% of reads into the hottest 10% → **99.2% hit rate**.

---

## Project layout

```text
src/
  constants.ts            PAGE_SIZE and every persisted magic number / tag (defined once)
  errors.ts               typed error hierarchy
  storage/                pager, bufferpool, slotted page, heap, B+Tree, Tx abstraction
  record/                 schema, tuple (de)serialization, value semantics, catalog
  sql/                    token, lexer, AST, recursive-descent parser
  plan/                   logical plan, optimizer, physical plan + EXPLAIN
  exec/                   Volcano operators, executor, table store, expression compiler
  txn/                    WAL, WAL-backed transaction, recovery, MVCC
  db.ts                   the Database facade
  repl.ts                 interactive shell
  bench/bench.ts          benchmarks
tests/                    Vitest suites mirroring src/
scripts/                  demo-pool, demo-crash, demo-explain
docs/db-engine-spec.md    the original build spec
```

## Durability testing

Durability is the product, so it is tested as such. A **deterministic crash-injection fuzzer**
(`tests/txn/crash-fuzz.test.ts`) runs randomized workloads — autocommit and explicit
commit/rollback transactions over an indexed table — then "crashes" the database, recovers, and
asserts the result exactly matches a reference oracle of committed state, with the secondary
index agreeing with the heap for every value. A second test crashes mid-commit at an fsync and
asserts the reopened database stays internally consistent. (Reverting the aborted-transaction
recovery fix makes the fuzzer fail — it has teeth.)

> Honest caveat: on macOS, `fsync(2)` does not flush the drive's write cache — true power-loss
> durability needs `fcntl(F_FULLFSYNC)`, which Node cannot issue without a native addon. The
> `Durability` layer is the single seam where a platform-correct full-sync would plug in.

## Known limitations (deliberate)

Deferred reclamation, by design: deletes are **tombstones** (B+Tree entries and heap slots),
B+Tree nodes are never merged or rebalanced, and rolled-back/dead versions leak space — a
vacuum/compaction pass would reclaim all of it. Rows must fit within a single page (no overflow
pages). Secondary indexes are on `INT` columns only. DDL inside an explicit transaction is
rejected (it would desynchronize the in-memory catalog from an on-disk rollback). The engine is
single-writer (enforced by the PID lock). There is no `JOIN` or `UPDATE` statement yet.

## License

MIT — see [LICENSE](LICENSE).
