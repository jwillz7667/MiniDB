import { U16, U32, USABLE_PAGE_SIZE } from "../constants.js";
import { CorruptDatabaseError } from "../errors.js";
import type { Tx } from "./tx.js";

/**
 * Overflow pages: a singly-linked chain that holds a byte string too large to
 * fit inline in a heap slot. Each page is `[next:u32][len:u16][payload]`, so the
 * payload capacity is the usable page minus that 6-byte header. The table store
 * spills any oversized tuple here and keeps only a small pointer in the heap.
 *
 * Like the rest of the engine, freed overflow chains are not reclaimed yet (no
 * vacuum / free list) — a documented limitation, matching tombstone deletes.
 */

const OVERFLOW_NEXT_OFFSET = 0; // u32
const OVERFLOW_LEN_OFFSET = U32; // u16
const OVERFLOW_HEADER = U32 + U16; // 6
const OVERFLOW_CAPACITY = USABLE_PAGE_SIZE - OVERFLOW_HEADER;

/**
 * Write `bytes` across a fresh overflow chain and return the first page number.
 * The chain is built tail-first so each page can record the (already-allocated)
 * next page; every page write goes through `tx.modify`, so the chain is logged
 * and recovery-safe just like any other page mutation.
 */
export function writeOverflow(tx: Tx, bytes: Buffer): number {
  const chunks = Math.max(1, Math.ceil(bytes.length / OVERFLOW_CAPACITY));
  let next = 0;
  for (let i = chunks - 1; i >= 0; i--) {
    const start = i * OVERFLOW_CAPACITY;
    const slice = bytes.subarray(start, start + OVERFLOW_CAPACITY);
    const pageNo = tx.allocate();
    const nextPage = next; // captured for the closure
    tx.modify(pageNo, (page) => {
      page.writeUInt32LE(nextPage, OVERFLOW_NEXT_OFFSET);
      page.writeUInt16LE(slice.length, OVERFLOW_LEN_OFFSET);
      slice.copy(page, OVERFLOW_HEADER);
    });
    next = pageNo;
  }
  return next;
}

/** Reassemble a value of `totalLen` bytes from an overflow chain. */
export function readOverflow(tx: Tx, firstPage: number, totalLen: number): Buffer {
  const out = Buffer.alloc(totalLen);
  let pageNo = firstPage;
  let pos = 0;
  while (pageNo !== 0) {
    const page = tx.read(pageNo);
    let next: number;
    let len: number;
    try {
      next = page.readUInt32LE(OVERFLOW_NEXT_OFFSET);
      len = page.readUInt16LE(OVERFLOW_LEN_OFFSET);
      if (len > OVERFLOW_CAPACITY || pos + len > totalLen) {
        throw new CorruptDatabaseError(
          `overflow page ${pageNo} declares ${len} bytes (pos ${pos}/${totalLen})`,
        );
      }
      page.copy(out, pos, OVERFLOW_HEADER, OVERFLOW_HEADER + len);
    } finally {
      tx.release(pageNo);
    }
    pos += len;
    pageNo = next;
  }
  if (pos !== totalLen) {
    throw new CorruptDatabaseError(`overflow chain yielded ${pos} bytes, expected ${totalLen}`);
  }
  return out;
}

export { OVERFLOW_CAPACITY };
