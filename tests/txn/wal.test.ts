import { readFileSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Wal } from "../../src/txn/wal.js";
import { makeTempDb, type TempDb } from "../helpers/tmp.js";

describe("Wal", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = makeTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("assigns increasing LSNs and round-trips records through disk", () => {
    const wal = Wal.open(tmp.walPath);
    const l1 = wal.append({ type: "begin", txid: 1n });
    const l2 = wal.append({
      type: "update",
      txid: 1n,
      pageNo: 7,
      offset: 16,
      before: Buffer.from([1, 2, 3]),
      after: Buffer.from([9, 8, 7]),
    });
    const l3 = wal.append({ type: "commit", txid: 1n });
    expect([l1, l2, l3]).toEqual([1n, 2n, 3n]);
    wal.flush();
    wal.close();

    const reader = Wal.open(tmp.walPath);
    const records = reader.readAll();
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ type: "begin", lsn: 1n, txid: 1n });
    expect(records[1]).toMatchObject({ type: "update", pageNo: 7, offset: 16 });
    const upd = records[1] as Extract<(typeof records)[number], { type: "update" }>;
    expect(upd.before.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(upd.after.equals(Buffer.from([9, 8, 7]))).toBe(true);
    expect(records[2]).toMatchObject({ type: "commit", lsn: 3n });
    reader.close();
  });

  it("round-trips a checkpoint record with active transaction ids", () => {
    const wal = Wal.open(tmp.walPath);
    wal.append({ type: "checkpoint", active: [5n, 9n] });
    wal.flush();
    wal.close();

    const records = Wal.open(tmp.walPath).readAll();
    expect(records[0]).toMatchObject({ type: "checkpoint", active: [5n, 9n] });
  });

  it("does not expose records that were appended but never flushed", () => {
    const wal = Wal.open(tmp.walPath);
    wal.append({ type: "begin", txid: 1n }); // buffered, not flushed
    expect(Wal.open(tmp.walPath).readAll()).toHaveLength(0);
  });

  it("stops at a torn trailing frame (partial write)", () => {
    const wal = Wal.open(tmp.walPath);
    wal.append({ type: "begin", txid: 1n });
    wal.append({ type: "commit", txid: 1n });
    wal.flush();
    wal.close();

    // Simulate a crash mid-append: tack on a length prefix with no payload.
    const bytes = readFileSync(tmp.walPath);
    const torn = Buffer.concat([bytes, Buffer.from([0xff, 0xff, 0x00, 0x00])]);
    writeFileSync(tmp.walPath, torn);

    const records = Wal.open(tmp.walPath).readAll();
    expect(records).toHaveLength(2); // the garbage tail is ignored
  });

  it("stops at the first CRC mismatch", () => {
    const wal = Wal.open(tmp.walPath);
    wal.append({ type: "begin", txid: 1n });
    wal.append({ type: "begin", txid: 2n });
    wal.flush();
    wal.close();

    // Flip a byte inside the first record's payload -> CRC fails -> stop there.
    const bytes = readFileSync(tmp.walPath);
    bytes[5] = bytes[5]! ^ 0xff;
    writeFileSync(tmp.walPath, bytes);

    expect(Wal.open(tmp.walPath).readAll()).toHaveLength(0);
  });

  it("truncate empties the log", () => {
    const wal = Wal.open(tmp.walPath);
    wal.append({ type: "begin", txid: 1n });
    wal.flush();
    wal.truncate();
    expect(wal.readAll()).toHaveLength(0);
    wal.close();
  });
});
