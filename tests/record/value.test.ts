import { describe, expect, it } from "vitest";

import { ExecutionError } from "../../src/errors.js";
import { compareValues, sortCompare, valueToDisplay, valueToLiteral } from "../../src/record/value.js";

describe("value semantics", () => {
  it("compares same-typed values", () => {
    expect(compareValues(1n, 2n)).toBeLessThan(0);
    expect(compareValues(2n, 2n)).toBe(0);
    expect(compareValues("a", "b")).toBeLessThan(0);
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(true, true)).toBe(0);
  });

  it("throws on a cross-type comparison", () => {
    expect(() => compareValues(1n, "a")).toThrow(ExecutionError);
  });

  it("sorts NULLs first (ascending)", () => {
    expect(sortCompare(null, null)).toBe(0);
    expect(sortCompare(null, 1n)).toBeLessThan(0);
    expect(sortCompare(1n, null)).toBeGreaterThan(0);
    expect(sortCompare(1n, 2n)).toBeLessThan(0);
  });

  it("renders values for display", () => {
    expect(valueToDisplay(null)).toBe("NULL");
    expect(valueToDisplay(true)).toBe("TRUE");
    expect(valueToDisplay(false)).toBe("FALSE");
    expect(valueToDisplay(42n)).toBe("42");
    expect(valueToDisplay("hi")).toBe("hi");
  });

  it("renders values as SQL literals, quoting and escaping text", () => {
    expect(valueToLiteral(null)).toBe("NULL");
    expect(valueToLiteral(true)).toBe("TRUE");
    expect(valueToLiteral(7n)).toBe("7");
    expect(valueToLiteral("o'brien")).toBe("'o''brien'");
  });
});
