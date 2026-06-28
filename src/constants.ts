/**
 * Cross-cutting on-disk constants. PAGE_SIZE and every persisted magic number /
 * type tag live here exactly once; no other file may hardcode these values.
 */

/** Size of one page on disk and in memory. The whole engine is built around this. */
export const PAGE_SIZE = 4096;

/** Magic string at the start of page 0. Identifies a file as a minidb database. */
export const MAGIC = "MNDB";
export const MAGIC_BYTES = 4;

/** On-disk format version, stored in the header so future changes can be detected. */
export const DB_FORMAT_VERSION = 1;

/**
 * Page 0 header layout. Page 0 is reserved for this header and is never used as a
 * heap or B+Tree page, which is why page number 0 can safely mean "no page".
 */
export const HEADER_MAGIC_OFFSET = 0; // 4 bytes, MAGIC
export const HEADER_VERSION_OFFSET = 4; // u16 format version
export const HEADER_PAGE_SIZE_OFFSET = 6; // u16 page size (sanity check on open)
export const HEADER_PAGE_COUNT_OFFSET = 8; // u32 number of pages in the file
export const HEADER_CATALOG_ROOT_OFFSET = 12; // u32 heap root of minidb_tables
export const HEADER_NEXT_TXID_OFFSET = 16; // u64 next transaction id to hand out

/** Sentinel page number meaning "none". Page 0 is the header, so 0 is never a real link. */
export const INVALID_PAGE = 0;

/** B+Tree node type tags (first byte of a B+Tree page). */
export const NODE_LEAF = 1;
export const NODE_INTERNAL = 2;

/** Column type tags, persisted in the catalog. */
export const TYPE_INT = 1;
export const TYPE_TEXT = 2;
export const TYPE_BOOL = 3;

/** WAL record type tags. */
export const WAL_BEGIN = 1;
export const WAL_UPDATE = 2;
export const WAL_COMMIT = 3;
export const WAL_ABORT = 4;
export const WAL_CHECKPOINT = 5;

/** Width of fixed-width on-disk fields, named so call sites read clearly. */
export const U8 = 1;
export const U16 = 2;
export const U32 = 4;
export const U64 = 8;
export const I64 = 8;
