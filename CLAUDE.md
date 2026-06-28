# MiniDB — engineering guide

A real, durable single-file SQL database engine written from scratch in TypeScript: a
B+Tree storage engine, a write-ahead log, ARIES-lite crash recovery, a Volcano query
executor, and MVCC snapshot isolation. The bar: kill the process mid-write, restart, and
read back consistent, committed data. `docs/db-engine-spec.md` is the source of truth —
read it before changing storage formats or recovery logic.

## Non-negotiable ground rules

- **No external DB/storage/parser libraries.** We wrote the storage layer ourselves. Byte
  work uses `Buffer`/`DataView` only. The only deps are dev tooling: `vitest`, `tsx`,
  `typescript`, `@types/node`. Do not add a runtime dependency.
- **Single data file** of fixed-size pages + one WAL file. Nothing else on disk.
- **`PAGE_SIZE` is defined once** in `src/constants.ts` and imported everywhere. Never
  hardcode `4096` (or any other on-disk magic number) anywhere else.
- **Tests are part of every change.** No feature is "done" until `pnpm test` is green.
  The crash-recovery tests are the centerpiece — never weaken them to make them pass.
- **Errors are thrown as typed classes** from `src/errors.ts`, never returned as `null`.
- **Small files, one responsibility.** Pure functions where possible; side effects at the
  edges (pager/WAL).

## Byte-layout conventions (apply everywhere)

- All multi-byte integers are **little-endian**.
- Page numbers are **u32**. **Page 0 is the database header.** Because no B+Tree node or
  heap page is ever page 0, the value `0` doubles as the null/invalid page pointer
  (`INVALID_PAGE`).
- Offsets within a page are **u16** (a page fits in 16 bits).
- Strings/blobs are length-prefixed: **u16 length, then UTF-8 bytes**.
- A tuple begins with a **null-bitmap** (ceil(numCols/8) bytes), one bit per column, bit
  set ⇒ column is NULL. Non-null columns follow in schema order.
- **`INT` is a signed 64-bit integer represented as a JS `bigint`** end to end (use
  `DataView.getBigInt64`/`setBigInt64`). This is deliberate: `number` loses precision past
  2^53. B+Tree keys are `bigint` too. SQL value type = `bigint | string | boolean | null`.

## Architecture (dependencies flow downward only)

```
repl / bench / db (facade)
        │
   exec (Volcano operators, executor)
        │
   plan (logical → optimizer → physical)
        │
   sql (lexer → parser → AST)
        │
   record (schema, tuple, catalog)
        │
   storage (btree, slotted page) ── txn (wal, recovery, transaction/MVCC)
        │
   bufferpool (clock eviction, pin/dirty) → pager (raw pages + fsync)
```

A lower layer never imports an upper one. The executor depends on B+Tree depends on buffer
pool depends on pager. **This order is load-bearing — do not reorder phases.**

## Key cross-cutting designs (read before touching storage or recovery)

- **Page access goes through a `Tx` interface** (`read`/`release`/`allocate`/`modify`).
  Access methods (heap, B+Tree) never mutate a buffer directly; they wrap every mutation
  in `tx.modify(pageNo, buf => { ... })`. Two implementations:
  - `DirectTx` — applies the mutation and marks the page dirty. No logging. Used by
    low-level unit tests and non-durable contexts.
  - `WalTx` — snapshots the page before the mutator runs, lets the mutator edit the buffer
    freely, then logs the **minimal changed byte span** (`firstDiff..lastDiff`) as a WAL
    `UPDATE` record (before + after images) before marking dirty. Logging is transparent to
    the access methods — this is how the B+Tree and heap stay recovery-agnostic.
- **Write-ahead rule.** The buffer pool refuses to flush a dirty page until the WAL is
  durable up to that page's `pageLSN` (tracked per frame). `WalTx` sets `pageLSN` on every
  logged mutation. Commit fsyncs the WAL through the COMMIT record.
- **Recovery is physical redo/undo (ARIES-lite, STEAL + NO-FORCE).** Redo re-applies every
  logged after-image (committed or not, idempotent); undo walks the full log backward
  applying before-images for "loser" (uncommitted) transactions. UPDATE records that
  reference a page beyond the current file size grow the file — this makes page
  *allocation* durable for free. Recovery exposes stats (`redoStartLsn`, counts) so the
  checkpoint optimization is testable.
- **Each WAL record carries a CRC32.** Replay stops at the first record with a bad/short
  checksum — that is the crash point. This is how torn trailing writes are tolerated.
- **Tombstone deletes only** (B+Tree entries and heap slots). No merge/rebalance, no page
  reclamation, no vacuum yet — documented as a known limitation, matching the spec.

## Commands

```bash
pnpm install          # esbuild build is pre-approved in pnpm-workspace.yaml
pnpm test             # vitest run — must be green before commit
pnpm test:watch
pnpm typecheck        # tsc --noEmit, strict
pnpm repl             # interactive SQL REPL (tsx)
pnpm bench            # throughput + latency benchmarks
pnpm demo:crash       # crash mid-write, recover clean (the headline demo)
pnpm demo:pool        # buffer-pool hit-rate demo
pnpm demo:explain     # optimizer choosing IndexScan over SeqScan
```

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any`,
  no non-null `!` to paper over logic, no `as` casts unless genuinely unavoidable (document
  why inline).
- ESM with `module: NodeNext`. **Relative imports must use the `.js` extension** (e.g.
  `import { Pager } from "./pager.js"`) even though the source is `.ts` — this is required
  by NodeNext and works under tsc, tsx, and vitest.
- `const` over `let`; never `var`. `async/await` over raw promises (the engine itself is
  synchronous on purpose — disk I/O via `fs` sync calls — so durability ordering is
  explicit and easy to reason about).
- Tests live in `tests/` mirroring `src/`, named `*.test.ts`. Name tests by behavior
  (`it("evicts the coldest unpinned frame")`), Arrange/Act/Assert with blank-line spacing.
- Conventional Commits, one logical change per commit (`feat(storage): ...`).
- Inline comments only explain non-obvious *why* (an invariant, a layout decision, a
  workaround) — never restate *what* the code does.
