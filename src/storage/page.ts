import { PAGE_SIZE } from "../constants.js";
import { SlottedPageError } from "../errors.js";

/**
 * Slotted-page layout for variable-length records (the standard heap-page
 * design). The slot array grows forward from the header; record bytes grow
 * backward from the end of the page. Inserting appends a slot at the front and
 * places the record at the back. Deletes are tombstones — the slot is cleared
 * but the bytes are left in place and the space is not reclaimed (no vacuum yet).
 *
 *   ┌────────┬───────────────┬───────────────────────┬──────────────┐
 *   │ header │ slot[0..n) →  │     ← free space →    │  ← records   │
 *   └────────┴───────────────┴───────────────────────┴──────────────┘
 */

const SLOT_COUNT_OFFSET = 0; // u16
const FREE_START_OFFSET = 2; // u16: lowest used record-data offset
const NEXT_PAGE_OFFSET = 4; // u32: heap chain pointer (0 = end)
const HEADER_SIZE = 8;
const SLOT_SIZE = 4; // u16 offset + u16 length
const SLOT_OFFSET_FIELD = 0;
const SLOT_LENGTH_FIELD = 2;

/** Largest record that can ever fit in an empty page (header + one slot reserved). */
export const MAX_RECORD_SIZE = PAGE_SIZE - HEADER_SIZE - SLOT_SIZE;

/** Initialize `page` as an empty slotted page linked to `nextPage`. */
export function initSlottedPage(page: Buffer, nextPage = 0): void {
  page.writeUInt16LE(0, SLOT_COUNT_OFFSET);
  page.writeUInt16LE(PAGE_SIZE, FREE_START_OFFSET);
  page.writeUInt32LE(nextPage, NEXT_PAGE_OFFSET);
}

export function slotCount(page: Buffer): number {
  return page.readUInt16LE(SLOT_COUNT_OFFSET);
}

export function getNextPage(page: Buffer): number {
  return page.readUInt32LE(NEXT_PAGE_OFFSET);
}

export function setNextPage(page: Buffer, nextPage: number): void {
  page.writeUInt32LE(nextPage, NEXT_PAGE_OFFSET);
}

function slotOffset(page: Buffer, slot: number): number {
  return page.readUInt16LE(HEADER_SIZE + slot * SLOT_SIZE + SLOT_OFFSET_FIELD);
}

function slotLength(page: Buffer, slot: number): number {
  return page.readUInt16LE(HEADER_SIZE + slot * SLOT_SIZE + SLOT_LENGTH_FIELD);
}

/** A tombstoned (deleted) slot stores offset 0; a live record never starts at 0. */
export function isDeleted(page: Buffer, slot: number): boolean {
  assertSlot(page, slot);
  return slotOffset(page, slot) === 0;
}

function assertSlot(page: Buffer, slot: number): void {
  const count = slotCount(page);
  if (slot < 0 || slot >= count) {
    throw new SlottedPageError(`slot ${slot} out of range [0, ${count})`);
  }
}

/** Bytes available for a new record's data, excluding the slot it would need. */
export function freeSpace(page: Buffer): number {
  const freeStart = page.readUInt16LE(FREE_START_OFFSET);
  const slotsEnd = HEADER_SIZE + slotCount(page) * SLOT_SIZE;
  return freeStart - slotsEnd;
}

/** Whether a record of `recordLen` bytes (plus its new slot) fits in this page. */
export function canInsert(page: Buffer, recordLen: number): boolean {
  return recordLen + SLOT_SIZE <= freeSpace(page);
}

/** Append a record, returning its slot index. Throws if it does not fit. */
export function insertRecord(page: Buffer, record: Buffer): number {
  if (record.length > MAX_RECORD_SIZE) {
    throw new SlottedPageError(
      `record of ${record.length} bytes exceeds max ${MAX_RECORD_SIZE} (page overflow not supported)`,
    );
  }
  if (!canInsert(page, record.length)) {
    throw new SlottedPageError(`record of ${record.length} bytes does not fit (free=${freeSpace(page)})`);
  }
  const count = slotCount(page);
  const freeStart = page.readUInt16LE(FREE_START_OFFSET);
  const dataOffset = freeStart - record.length;

  record.copy(page, dataOffset);
  page.writeUInt16LE(dataOffset, HEADER_SIZE + count * SLOT_SIZE + SLOT_OFFSET_FIELD);
  page.writeUInt16LE(record.length, HEADER_SIZE + count * SLOT_SIZE + SLOT_LENGTH_FIELD);
  page.writeUInt16LE(count + 1, SLOT_COUNT_OFFSET);
  page.writeUInt16LE(dataOffset, FREE_START_OFFSET);
  return count;
}

/**
 * Byte offset of the record at `slot` within the page. Lets callers (e.g. the
 * MVCC store) overwrite a fixed-width field of a record in place.
 */
export function recordOffset(page: Buffer, slot: number): number {
  assertSlot(page, slot);
  const offset = slotOffset(page, slot);
  if (offset === 0) throw new SlottedPageError(`record at slot ${slot} is deleted`);
  return offset;
}

/** Return a copy of the record at `slot`. Throws if the slot is tombstoned. */
export function getRecord(page: Buffer, slot: number): Buffer {
  assertSlot(page, slot);
  const offset = slotOffset(page, slot);
  if (offset === 0) throw new SlottedPageError(`record at slot ${slot} is deleted`);
  const length = slotLength(page, slot);
  return Buffer.from(page.subarray(offset, offset + length));
}

/** Tombstone the record at `slot`. The bytes remain but become unreachable. */
export function deleteRecord(page: Buffer, slot: number): void {
  assertSlot(page, slot);
  page.writeUInt16LE(0, HEADER_SIZE + slot * SLOT_SIZE + SLOT_OFFSET_FIELD);
  page.writeUInt16LE(0, HEADER_SIZE + slot * SLOT_SIZE + SLOT_LENGTH_FIELD);
}
