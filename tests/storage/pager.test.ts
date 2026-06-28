import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PAGE_SIZE } from "../../src/constants.js";
import { CorruptDatabaseError, PageError } from "../../src/errors.js";
import { Pager } from "../../src/storage/pager.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

describe("Pager", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = makeTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("creates a fresh file with just the header page", () => {
    const pager = Pager.open(tmp.path);

    expect(pager.pageCount()).toBe(1);
    expect(pager.getCatalogRoot()).toBe(0);
    expect(pager.getNextTxid()).toBe(1n);

    pager.close();
  });

  it("allocates pages and round-trips page contents", () => {
    const pager = Pager.open(tmp.path);

    const p1 = pager.allocatePage();
    const p2 = pager.allocatePage();
    expect(p1).toBe(1);
    expect(p2).toBe(2);
    expect(pager.pageCount()).toBe(3);

    const buf = Buffer.alloc(PAGE_SIZE, 0xab);
    buf.writeUInt32LE(0xdeadbeef, 0);
    pager.writePage(p2, buf, true);

    const read = pager.readPage(p2);
    expect(read.readUInt32LE(0)).toBe(0xdeadbeef);
    expect(read[100]).toBe(0xab);

    pager.close();
  });

  it("persists data and header across reopen", () => {
    const first = Pager.open(tmp.path);
    const pageNo = first.allocatePage();
    const buf = Buffer.alloc(PAGE_SIZE);
    buf.write("durable", 0, "utf8");
    first.writePage(pageNo, buf, true);
    first.setCatalogRoot(pageNo);
    first.setNextTxid(42n);
    first.close();

    const second = Pager.open(tmp.path);
    expect(second.pageCount()).toBe(2);
    expect(second.getCatalogRoot()).toBe(pageNo);
    expect(second.getNextTxid()).toBe(42n);
    expect(second.readPage(pageNo).toString("utf8", 0, 7)).toBe("durable");
    second.close();
  });

  it("rejects a file with the wrong magic", () => {
    const garbage = Pager.open(tmp.path);
    garbage.close();
    // Corrupt the magic by overwriting the header with a non-minidb page.
    const bad = Buffer.alloc(PAGE_SIZE);
    bad.write("XXXX", 0, "ascii");
    writeFileSync(tmp.path, bad);

    expect(() => Pager.open(tmp.path)).toThrow(CorruptDatabaseError);
  });

  it("throws on out-of-range page access", () => {
    const pager = Pager.open(tmp.path);
    expect(() => pager.readPage(5)).toThrow(PageError);
    pager.close();
  });

  it("grows the file to satisfy ensurePageCount (recovery path)", () => {
    const pager = Pager.open(tmp.path);
    pager.ensurePageCount(10);
    expect(pager.pageCount()).toBe(10);
    // Newly grown pages read back as zeros.
    expect(pager.readPage(9).every((b) => b === 0)).toBe(true);
    pager.close();
  });
});
