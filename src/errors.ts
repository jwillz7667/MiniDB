/**
 * Typed error hierarchy. Every failure path throws one of these instead of
 * returning null, so callers can discriminate on `instanceof` and the message
 * always carries enough context to debug from a log line alone.
 */

export class MiniDBError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    // Restore the prototype chain for reliable `instanceof` across transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The file on disk is not a minidb database, or its header is inconsistent. */
export class CorruptDatabaseError extends MiniDBError {}

/** A page number was out of range, or a page's contents violate an invariant. */
export class PageError extends MiniDBError {}

/** The buffer pool cannot satisfy a request (e.g. every frame is pinned). */
export class BufferPoolError extends MiniDBError {}

/** A B+Tree invariant was violated (duplicate key, node overflow, bad descent). */
export class BTreeError extends MiniDBError {}

/** A slotted page operation failed (record too large, bad slot, no free space). */
export class SlottedPageError extends MiniDBError {}

/** Serialization/deserialization of a tuple against its schema failed. */
export class TupleError extends MiniDBError {}

/** Catalog lookup failed: unknown table, unknown column, duplicate definition. */
export class CatalogError extends MiniDBError {}

/** The lexer hit a character it cannot tokenize. Carries 1-based line/column. */
export class LexError extends MiniDBError {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

/** The parser found a token it did not expect. Carries the offending position. */
export class ParseError extends MiniDBError {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

/** Binding parameters to a prepared statement failed (count/type mismatch). */
export class BindError extends MiniDBError {}

/** Planning failed: query references something that cannot be resolved/optimized. */
export class PlanError extends MiniDBError {}

/** Execution failed: type mismatch in a predicate, write conflict, etc. */
export class ExecutionError extends MiniDBError {}

/** The write-ahead log or recovery encountered an unrecoverable condition. */
export class WalError extends MiniDBError {}

/** The database file is already open elsewhere (another live process/instance). */
export class LockError extends MiniDBError {}

/** A transaction was used illegally (e.g. after commit) or hit an MVCC conflict. */
export class TransactionError extends MiniDBError {}
