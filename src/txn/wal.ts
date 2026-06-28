import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";

import {
  U16,
  U32,
  U64,
  U8,
  WAL_ABORT,
  WAL_BEGIN,
  WAL_CHECKPOINT,
  WAL_COMMIT,
  WAL_UPDATE,
} from "../constants.js";
import { WalError } from "../errors.js";

/** A decoded log record. Each carries a monotonically increasing LSN. */
export type WalRecord =
  | { readonly type: "begin"; readonly lsn: bigint; readonly txid: bigint }
  | {
      readonly type: "update";
      readonly lsn: bigint;
      readonly txid: bigint;
      readonly pageNo: number;
      readonly offset: number;
      readonly before: Buffer;
      readonly after: Buffer;
    }
  | { readonly type: "commit"; readonly lsn: bigint; readonly txid: bigint }
  | { readonly type: "abort"; readonly lsn: bigint; readonly txid: bigint }
  | { readonly type: "checkpoint"; readonly lsn: bigint; readonly active: bigint[] };

/** What a caller appends; the LSN is assigned by the log. */
export type WalRecordSpec =
  | { readonly type: "begin"; readonly txid: bigint }
  | {
      readonly type: "update";
      readonly txid: bigint;
      readonly pageNo: number;
      readonly offset: number;
      readonly before: Buffer;
      readonly after: Buffer;
    }
  | { readonly type: "commit"; readonly txid: bigint }
  | { readonly type: "abort"; readonly txid: bigint }
  | { readonly type: "checkpoint"; readonly active: bigint[] };

// ---- CRC32 (IEEE polynomial), so a torn trailing record is detectable -------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function encodePayload(spec: WalRecordSpec, lsn: bigint): Buffer {
  switch (spec.type) {
    case "begin":
    case "commit":
    case "abort": {
      const buf = Buffer.alloc(U8 + U64 + U64);
      buf.writeUInt8(typeTag(spec.type), 0);
      buf.writeBigUInt64LE(lsn, U8);
      buf.writeBigUInt64LE(spec.txid, U8 + U64);
      return buf;
    }
    case "update": {
      const len = spec.after.length;
      if (spec.before.length !== len) {
        throw new WalError("update before/after images must be the same length");
      }
      const buf = Buffer.alloc(U8 + U64 + U64 + U32 + U16 + U16 + len * 2);
      let o = 0;
      o = buf.writeUInt8(WAL_UPDATE, o);
      o = buf.writeBigUInt64LE(lsn, o);
      o = buf.writeBigUInt64LE(spec.txid, o);
      o = buf.writeUInt32LE(spec.pageNo, o);
      o = buf.writeUInt16LE(spec.offset, o);
      o = buf.writeUInt16LE(len, o);
      o += spec.before.copy(buf, o);
      spec.after.copy(buf, o);
      return buf;
    }
    case "checkpoint": {
      const buf = Buffer.alloc(U8 + U64 + U64 + U32 + spec.active.length * U64);
      let o = 0;
      o = buf.writeUInt8(WAL_CHECKPOINT, o);
      o = buf.writeBigUInt64LE(lsn, o);
      o = buf.writeBigUInt64LE(0n, o); // txid slot unused for checkpoints
      o = buf.writeUInt32LE(spec.active.length, o);
      for (const txid of spec.active) o = buf.writeBigUInt64LE(txid, o);
      return buf;
    }
  }
}

function typeTag(type: "begin" | "commit" | "abort"): number {
  return type === "begin" ? WAL_BEGIN : type === "commit" ? WAL_COMMIT : WAL_ABORT;
}

function decodePayload(payload: Buffer): WalRecord {
  const type = payload.readUInt8(0);
  const lsn = payload.readBigUInt64LE(U8);
  const txid = payload.readBigUInt64LE(U8 + U64);
  switch (type) {
    case WAL_BEGIN:
      return { type: "begin", lsn, txid };
    case WAL_COMMIT:
      return { type: "commit", lsn, txid };
    case WAL_ABORT:
      return { type: "abort", lsn, txid };
    case WAL_UPDATE: {
      let o = U8 + U64 + U64;
      const pageNo = payload.readUInt32LE(o);
      o += U32;
      const offset = payload.readUInt16LE(o);
      o += U16;
      const len = payload.readUInt16LE(o);
      o += U16;
      const before = Buffer.from(payload.subarray(o, o + len));
      const after = Buffer.from(payload.subarray(o + len, o + len * 2));
      return { type: "update", lsn, txid, pageNo, offset, before, after };
    }
    case WAL_CHECKPOINT: {
      let o = U8 + U64 + U64;
      const count = payload.readUInt32LE(o);
      o += U32;
      const active: bigint[] = [];
      for (let i = 0; i < count; i++) {
        active.push(payload.readBigUInt64LE(o));
        o += U64;
      }
      return { type: "checkpoint", lsn, active };
    }
    default:
      throw new WalError(`unknown WAL record type ${type}`);
  }
}

const LENGTH_PREFIX = U32;
const CRC_SUFFIX = U32;

/**
 * The write-ahead log: an append-only file of length-prefixed, CRC32-checked
 * records. Appends are buffered in memory; `flush` writes the buffer and fsyncs,
 * which is the only point at which records become durable. The buffer pool calls
 * `flush` before writing any dirty page, and commit calls it through the COMMIT
 * record — together that is the write-ahead guarantee.
 */
export class Wal {
  private pending: Buffer[] = [];
  private nextLsn: bigint;

  private constructor(
    private readonly fd: number,
    readonly path: string,
    private size: number,
    startLsn: bigint,
  ) {
    this.nextLsn = startLsn;
  }

  static open(path: string, startLsn = 1n): Wal {
    const fd = openSync(path, existsSync(path) ? "r+" : "w+");
    return new Wal(fd, path, fstatSync(fd).size, startLsn);
  }

  /** LSN that will be assigned to the next appended record. */
  peekNextLsn(): bigint {
    return this.nextLsn;
  }

  /** Force the next LSN forward (used after recovery rebuilds the high-water mark). */
  setNextLsn(lsn: bigint): void {
    if (lsn > this.nextLsn) this.nextLsn = lsn;
  }

  /** Append a record (buffered, not yet durable). Returns its LSN. */
  append(spec: WalRecordSpec): bigint {
    const lsn = this.nextLsn;
    this.nextLsn += 1n;
    const payload = encodePayload(spec, lsn);
    const frame = Buffer.alloc(LENGTH_PREFIX + payload.length + CRC_SUFFIX);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, LENGTH_PREFIX);
    frame.writeUInt32LE(crc32(payload), LENGTH_PREFIX + payload.length);
    this.pending.push(frame);
    return lsn;
  }

  /** Write buffered records to disk and fsync. `upToLsn` is advisory — we always
   *  flush everything pending, which trivially satisfies any lower bound. */
  flush(_upToLsn?: bigint): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending);
    writeSync(this.fd, batch, 0, batch.length, this.size);
    this.size += batch.length;
    this.pending = [];
    fsyncSync(this.fd);
  }

  /**
   * Read every durable record, stopping at the first torn or corrupt frame —
   * that frame marks where a crash interrupted a write, and everything after it
   * is discarded.
   */
  readAll(): WalRecord[] {
    const size = fstatSync(this.fd).size;
    if (size === 0) return [];
    const buf = Buffer.alloc(size);
    readSync(this.fd, buf, 0, size, 0);

    const out: WalRecord[] = [];
    let pos = 0;
    while (pos + LENGTH_PREFIX <= size) {
      const payloadLen = buf.readUInt32LE(pos);
      const frameEnd = pos + LENGTH_PREFIX + payloadLen + CRC_SUFFIX;
      if (frameEnd > size) break; // torn: trailing partial frame
      const payload = buf.subarray(pos + LENGTH_PREFIX, pos + LENGTH_PREFIX + payloadLen);
      const stored = buf.readUInt32LE(pos + LENGTH_PREFIX + payloadLen);
      if (crc32(payload) !== stored) break; // corrupt: stop here
      out.push(decodePayload(payload));
      pos = frameEnd;
    }
    return out;
  }

  /** Empty the log (after recovery or a checkpoint folds it into the data file). */
  truncate(): void {
    ftruncateSync(this.fd, 0);
    this.size = 0;
    this.pending = [];
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}
