import { U16, U64 } from "../constants.js";
import { TupleError } from "../errors.js";
import type { Row, Schema, Value } from "./schema.js";
import { coerceToColumnType } from "./value.js";

/**
 * Tuple (de)serialization. A row's bytes begin with a null-bitmap — ceil(n/8)
 * bytes, one bit per column, set ⇒ NULL — followed by each non-null column
 * packed by type:
 *   INT      → 8-byte little-endian signed integer (bigint)
 *   REAL     → 8-byte little-endian IEEE-754 double
 *   TEXT     → u16 byte length, then UTF-8 bytes
 *   BOOL     → 1 byte (0 or 1)
 *   BLOB     → u16 byte length, then raw bytes
 *   DATETIME → 8-byte little-endian signed integer (epoch milliseconds)
 */

function bitmapBytes(columnCount: number): number {
  return Math.ceil(columnCount / 8);
}

function validate(schema: Schema, row: Row): void {
  if (row.length !== schema.columns.length) {
    throw new TupleError(
      `row has ${row.length} values but schema has ${schema.columns.length} columns`,
    );
  }
}

export function serialize(schema: Schema, row: Row): Buffer {
  validate(schema, row);
  const n = schema.columns.length;
  const bmLen = bitmapBytes(n);
  const bitmap = Buffer.alloc(bmLen);
  const parts: Buffer[] = [];

  for (let i = 0; i < n; i++) {
    const col = schema.columns[i]!;
    const value = row[i]!;

    if (value === null) {
      if (!col.nullable) throw new TupleError(`column "${col.name}" is NOT NULL`);
      bitmap[i >> 3]! |= 1 << (i & 7);
      continue;
    }

    const v = coerceToColumnType(col.type, value, col.name);
    switch (col.type) {
      case "INT": {
        const buf = Buffer.alloc(U64);
        buf.writeBigInt64LE(v as bigint); // throws if outside signed 64-bit range
        parts.push(buf);
        break;
      }
      case "REAL": {
        const buf = Buffer.alloc(U64);
        buf.writeDoubleLE(v as number);
        parts.push(buf);
        break;
      }
      case "DATETIME": {
        const buf = Buffer.alloc(U64);
        buf.writeBigInt64LE(BigInt((v as Date).getTime()));
        parts.push(buf);
        break;
      }
      case "TEXT": {
        const utf8 = Buffer.from(v as string, "utf8");
        if (utf8.length > 0xffff) {
          throw new TupleError(`TEXT value for "${col.name}" exceeds ${0xffff} bytes`);
        }
        const len = Buffer.alloc(U16);
        len.writeUInt16LE(utf8.length);
        parts.push(len, utf8);
        break;
      }
      case "BLOB": {
        const bytes = v as Buffer;
        if (bytes.length > 0xffff) {
          throw new TupleError(`BLOB value for "${col.name}" exceeds ${0xffff} bytes`);
        }
        const len = Buffer.alloc(U16);
        len.writeUInt16LE(bytes.length);
        parts.push(len, bytes);
        break;
      }
      case "BOOL": {
        parts.push(Buffer.from([(v as boolean) ? 1 : 0]));
        break;
      }
    }
  }

  return Buffer.concat([bitmap, ...parts]);
}

export function deserialize(schema: Schema, buf: Buffer): Row {
  const n = schema.columns.length;
  const bmLen = bitmapBytes(n);
  if (buf.length < bmLen) {
    throw new TupleError(`tuple buffer too short for null bitmap (${buf.length} < ${bmLen})`);
  }

  const row: Row = new Array<Value>(n);
  let offset = bmLen;

  for (let i = 0; i < n; i++) {
    const col = schema.columns[i]!;
    const isNull = (buf[i >> 3]! & (1 << (i & 7))) !== 0;
    if (isNull) {
      row[i] = null;
      continue;
    }

    switch (col.type) {
      case "INT": {
        if (offset + U64 > buf.length) throw new TupleError(`truncated INT for "${col.name}"`);
        row[i] = buf.readBigInt64LE(offset);
        offset += U64;
        break;
      }
      case "REAL": {
        if (offset + U64 > buf.length) throw new TupleError(`truncated REAL for "${col.name}"`);
        row[i] = buf.readDoubleLE(offset);
        offset += U64;
        break;
      }
      case "DATETIME": {
        if (offset + U64 > buf.length) throw new TupleError(`truncated DATETIME for "${col.name}"`);
        row[i] = new Date(Number(buf.readBigInt64LE(offset)));
        offset += U64;
        break;
      }
      case "TEXT": {
        if (offset + U16 > buf.length) throw new TupleError(`truncated TEXT length for "${col.name}"`);
        const len = buf.readUInt16LE(offset);
        offset += U16;
        if (offset + len > buf.length) throw new TupleError(`truncated TEXT body for "${col.name}"`);
        row[i] = buf.toString("utf8", offset, offset + len);
        offset += len;
        break;
      }
      case "BLOB": {
        if (offset + U16 > buf.length) throw new TupleError(`truncated BLOB length for "${col.name}"`);
        const len = buf.readUInt16LE(offset);
        offset += U16;
        if (offset + len > buf.length) throw new TupleError(`truncated BLOB body for "${col.name}"`);
        row[i] = Buffer.from(buf.subarray(offset, offset + len));
        offset += len;
        break;
      }
      case "BOOL": {
        if (offset + 1 > buf.length) throw new TupleError(`truncated BOOL for "${col.name}"`);
        row[i] = buf[offset]! !== 0;
        offset += 1;
        break;
      }
    }
  }

  return row;
}
