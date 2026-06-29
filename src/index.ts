/**
 * minidb — a durable, single-file SQL database engine written from scratch in
 * TypeScript, with no native dependency. This is the public API surface; the
 * Kysely dialect is published separately as `minidb/kysely`.
 */

export { Database, type DatabaseOptions, type ExecResult } from "./db.js";
export { AsyncDatabase, AsyncStatement, AsyncTransaction } from "./async.js";
export { PreparedStatement, type Row, type RunResult } from "./statement.js";
export type { QueryResult } from "./exec/executor.js";

// Value model
export type { Value, ColumnType, Column, Schema } from "./record/schema.js";
export type { BindValue } from "./sql/bind.js";

// Storage backends (the filesystem is the default; MemoryVfs runs in RAM)
export { MemoryVfs } from "./storage/memory-vfs.js";
export { nodeVfs, type Vfs, type VfsFile, type VfsLock } from "./storage/vfs.js";
export type { SyncMode } from "./storage/durability.js";
export type { RecoveryStats } from "./txn/recovery.js";

// Typed error hierarchy (every failure path throws one of these)
export {
  MiniDBError,
  BindError,
  BTreeError,
  BufferPoolError,
  CatalogError,
  ConstraintError,
  CorruptDatabaseError,
  ExecutionError,
  LexError,
  LockError,
  PageError,
  ParseError,
  PlanError,
  SlottedPageError,
  TransactionError,
  TupleError,
  WalError,
} from "./errors.js";
