import { describe, expect, it } from "vitest";

import { PAGE_SIZE, USABLE_PAGE_SIZE } from "../../src/constants.js";
import { SlottedPageError } from "../../src/errors.js";
import {
  canInsert,
  deleteRecord,
  freeSpace,
  getNextPage,
  getRecord,
  initSlottedPage,
  insertRecord,
  isDeleted,
  MAX_RECORD_SIZE,
  setNextPage,
  slotCount,
} from "../../src/storage/page.js";

function newPage(): Buffer {
  const page = Buffer.alloc(PAGE_SIZE);
  initSlottedPage(page);
  return page;
}

describe("slotted page", () => {
  it("packs multiple variable-length records and reads each back", () => {
    const page = newPage();
    const records = [
      Buffer.from("a"),
      Buffer.from("hello world"),
      Buffer.from([1, 2, 3, 4, 5]),
      Buffer.from("x".repeat(1000)),
    ];

    const slots = records.map((r) => insertRecord(page, r));
    expect(slots).toEqual([0, 1, 2, 3]);
    expect(slotCount(page)).toBe(4);

    records.forEach((r, i) => {
      expect(getRecord(page, slots[i]!).equals(r)).toBe(true);
    });
  });

  it("tombstones deleted records but keeps the rest readable", () => {
    const page = newPage();
    const a = insertRecord(page, Buffer.from("alpha"));
    const b = insertRecord(page, Buffer.from("bravo"));
    const c = insertRecord(page, Buffer.from("charlie"));

    deleteRecord(page, b);

    expect(isDeleted(page, b)).toBe(true);
    expect(() => getRecord(page, b)).toThrow(SlottedPageError);
    expect(getRecord(page, a).toString()).toBe("alpha");
    expect(getRecord(page, c).toString()).toBe("charlie");
    // Slot count is unchanged: deletion does not compact.
    expect(slotCount(page)).toBe(3);
  });

  it("reports free space and refuses records that do not fit", () => {
    const page = newPage();
    expect(freeSpace(page)).toBe(USABLE_PAGE_SIZE - 8); // header is 8 bytes; trailer reserved

    const big = Buffer.alloc(MAX_RECORD_SIZE);
    expect(canInsert(page, big.length)).toBe(true);
    insertRecord(page, big);
    expect(canInsert(page, 1)).toBe(false);
    expect(() => insertRecord(page, Buffer.from("x"))).toThrow(SlottedPageError);
  });

  it("rejects a record larger than a page can ever hold", () => {
    const page = newPage();
    expect(() => insertRecord(page, Buffer.alloc(MAX_RECORD_SIZE + 1))).toThrow(SlottedPageError);
  });

  it("stores the heap-chain next-page pointer", () => {
    const page = newPage();
    expect(getNextPage(page)).toBe(0);
    setNextPage(page, 99);
    expect(getNextPage(page)).toBe(99);
  });
});
