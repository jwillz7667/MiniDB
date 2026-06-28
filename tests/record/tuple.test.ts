import { describe, expect, it } from "vitest";

import { TupleError } from "../../src/errors.js";
import { makeSchema, type Row } from "../../src/record/schema.js";
import { deserialize, serialize } from "../../src/record/tuple.js";

const schema = makeSchema([
  { name: "id", type: "INT", nullable: false },
  { name: "name", type: "TEXT", nullable: true },
  { name: "active", type: "BOOL", nullable: false },
  { name: "score", type: "INT", nullable: true },
]);

function roundTrip(row: Row): Row {
  return deserialize(schema, serialize(schema, row));
}

describe("tuple serialization", () => {
  it("round-trips every column type", () => {
    const row: Row = [42n, "minidb", true, -7n];
    expect(roundTrip(row)).toEqual(row);
  });

  it("round-trips nulls via the null bitmap", () => {
    const row: Row = [1n, null, false, null];
    expect(roundTrip(row)).toEqual(row);
  });

  it("preserves the full signed 64-bit integer range", () => {
    const max: Row = [9_223_372_036_854_775_807n, "max", true, null];
    const min: Row = [-9_223_372_036_854_775_808n, "min", false, null];
    expect(roundTrip(max)).toEqual(max);
    expect(roundTrip(min)).toEqual(min);
  });

  it("handles unicode and empty text", () => {
    const row: Row = [0n, "héllo 世界 🚀", true, null];
    expect(roundTrip(row)).toEqual(row);
    const empty: Row = [0n, "", true, null];
    expect(roundTrip(empty)).toEqual(empty);
  });

  it("rejects NULL in a NOT NULL column", () => {
    expect(() => serialize(schema, [null, "x", true, null])).toThrow(TupleError);
  });

  it("rejects a wrong-typed value", () => {
    expect(() => serialize(schema, [1n, 5n as unknown as string, true, null])).toThrow(TupleError);
    expect(() => serialize(schema, ["nope" as unknown as bigint, "x", true, null])).toThrow(
      TupleError,
    );
  });

  it("rejects an INT outside the signed 64-bit range", () => {
    expect(() => serialize(schema, [9_223_372_036_854_775_808n, "x", true, null])).toThrow();
  });

  it("rejects a row with the wrong number of values", () => {
    expect(() => serialize(schema, [1n, "x", true] as unknown as Row)).toThrow(TupleError);
  });
});
