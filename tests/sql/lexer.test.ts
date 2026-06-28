import { describe, expect, it } from "vitest";

import { LexError } from "../../src/errors.js";
import { tokenize } from "../../src/sql/lexer.js";

/** Strip positions for compact assertions on (type, value) pairs. */
function pairs(sql: string): Array<[string, string]> {
  return tokenize(sql)
    .filter((t) => t.type !== "eof")
    .map((t) => [t.type, t.value]);
}

describe("lexer", () => {
  it("tokenizes keywords case-insensitively and canonicalizes them", () => {
    expect(pairs("Select * FROM users")).toEqual([
      ["keyword", "SELECT"],
      ["punctuation", "*"],
      ["keyword", "FROM"],
      ["identifier", "users"],
    ]);
  });

  it("lexes integers, strings, operators and punctuation", () => {
    expect(pairs("x >= 10 , y != 'a''b'")).toEqual([
      ["identifier", "x"],
      ["operator", ">="],
      ["integer", "10"],
      ["punctuation", ","],
      ["identifier", "y"],
      ["operator", "!="],
      ["string", "a'b"], // '' is an escaped single quote
    ]);
  });

  it("skips -- line comments but keeps the minus operator", () => {
    expect(pairs("a = 1 -- trailing comment\n - 2")).toEqual([
      ["identifier", "a"],
      ["operator", "="],
      ["integer", "1"],
      ["punctuation", "-"],
      ["integer", "2"],
    ]);
  });

  it("reports an unexpected character with line and column", () => {
    try {
      tokenize("select @");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LexError);
      const e = err as LexError;
      expect(e.line).toBe(1);
      expect(e.column).toBe(8);
    }
  });

  it("throws on an unterminated string", () => {
    expect(() => tokenize("insert 'oops")).toThrow(LexError);
  });

  it("tracks line numbers across newlines", () => {
    const tokens = tokenize("select\n  x");
    const x = tokens.find((t) => t.value === "x");
    expect(x?.line).toBe(2);
    expect(x?.column).toBe(3);
  });
});
