import { describe, expect, it } from "vitest";

import { ParseError } from "../../src/errors.js";
import type {
  CreateTableStmt,
  DeleteStmt,
  InsertStmt,
  LiteralExpr,
  LiteralValue,
  SelectStmt,
} from "../../src/sql/ast.js";
import { parse } from "../../src/sql/parser.js";

const lit = (value: LiteralValue): LiteralExpr => ({ kind: "literal", value });

describe("parser", () => {
  it("parses CREATE TABLE with types and NOT NULL", () => {
    const stmt = parse(
      "CREATE TABLE users (id INT NOT NULL, name TEXT, active BOOL NOT NULL)",
    ) as CreateTableStmt;
    expect(stmt.kind).toBe("createTable");
    expect(stmt.table).toBe("users");
    expect(stmt.columns).toEqual([
      { name: "id", type: "INT", nullable: false },
      { name: "name", type: "TEXT", nullable: true },
      { name: "active", type: "BOOL", nullable: false },
    ]);
  });

  it("parses CREATE INDEX", () => {
    expect(parse("CREATE INDEX ON users (id)")).toEqual({
      kind: "createIndex",
      table: "users",
      column: "id",
    });
  });

  it("parses INSERT with column list and multiple rows", () => {
    const stmt = parse(
      "INSERT INTO users (id, name, active) VALUES (1, 'ann', TRUE), (2, 'bob', FALSE)",
    ) as InsertStmt;
    expect(stmt.table).toBe("users");
    expect(stmt.columns).toEqual(["id", "name", "active"]);
    // Rows are value expressions (literal or `?` placeholder) resolved at bind time.
    expect(stmt.rows).toEqual([
      [lit(1n), lit("ann"), lit(true)],
      [lit(2n), lit("bob"), lit(false)],
    ]);
  });

  it("parses negative integers and NULL literals", () => {
    const stmt = parse("INSERT INTO t VALUES (-5, NULL)") as InsertStmt;
    expect(stmt.columns).toBeNull();
    expect(stmt.rows).toEqual([[lit(-5n), lit(null)]]);
  });

  it("parses `?` placeholders into positional param nodes", () => {
    const stmt = parse("INSERT INTO t (a, b) VALUES (?, ?), (?, 9)") as InsertStmt;
    expect(stmt.rows).toEqual([
      [{ kind: "param", index: 0 }, { kind: "param", index: 1 }],
      [{ kind: "param", index: 2 }, lit(9n)],
    ]);
  });

  it("parses SELECT with WHERE, ORDER BY, and LIMIT", () => {
    const stmt = parse(
      "SELECT id, name FROM users WHERE id >= 10 ORDER BY name DESC LIMIT 5",
    ) as SelectStmt;
    expect(stmt.columns).toEqual(["id", "name"]);
    expect(stmt.table).toBe("users");
    expect(stmt.orderBy).toEqual({ column: "name", dir: "DESC" });
    expect(stmt.limit).toBe(5);
    expect(stmt.where).toEqual({
      kind: "compare",
      op: ">=",
      left: { kind: "column", name: "id" },
      right: { kind: "literal", value: 10n },
    });
  });

  it("parses SELECT * with default ascending order", () => {
    const stmt = parse("SELECT * FROM t ORDER BY x") as SelectStmt;
    expect(stmt.columns).toBe("*");
    expect(stmt.orderBy).toEqual({ column: "x", dir: "ASC" });
  });

  it("parses DELETE with a WHERE clause", () => {
    const stmt = parse("DELETE FROM users WHERE id = 1") as DeleteStmt;
    expect(stmt.table).toBe("users");
    expect(stmt.where).toEqual({
      kind: "compare",
      op: "=",
      left: { kind: "column", name: "id" },
      right: { kind: "literal", value: 1n },
    });
  });

  it("binds AND tighter than OR", () => {
    const stmt = parse("SELECT * FROM t WHERE a = 1 AND b > 2 OR c = 3") as SelectStmt;
    // Expected: ((a = 1 AND b > 2) OR c = 3)
    expect(stmt.where).toEqual({
      kind: "logical",
      op: "OR",
      left: {
        kind: "logical",
        op: "AND",
        left: {
          kind: "compare",
          op: "=",
          left: { kind: "column", name: "a" },
          right: { kind: "literal", value: 1n },
        },
        right: {
          kind: "compare",
          op: ">",
          left: { kind: "column", name: "b" },
          right: { kind: "literal", value: 2n },
        },
      },
      right: {
        kind: "compare",
        op: "=",
        left: { kind: "column", name: "c" },
        right: { kind: "literal", value: 3n },
      },
    });
  });

  it("honors parentheses over default precedence", () => {
    const stmt = parse("SELECT * FROM t WHERE a = 1 AND (b = 2 OR c = 3)") as SelectStmt;
    expect(stmt.where?.kind).toBe("logical");
    const root = stmt.where as Extract<typeof stmt.where, { kind: "logical" }>;
    expect(root.op).toBe("AND");
    expect(root.right.kind).toBe("logical");
  });

  it("parses EXPLAIN of a SELECT", () => {
    const stmt = parse("EXPLAIN SELECT * FROM t");
    expect(stmt.kind).toBe("explain");
  });

  it("parses transaction control statements", () => {
    expect(parse("BEGIN").kind).toBe("begin");
    expect(parse("COMMIT").kind).toBe("commit");
    expect(parse("ROLLBACK").kind).toBe("rollback");
  });

  it("throws a readable error pointing at the bad token", () => {
    try {
      parse("SELECT FROM t");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toContain("FROM");
    }

    expect(() => parse("SELECT * FROM")).toThrow(ParseError); // missing table name
    expect(() => parse("CREATE TABLE t (id NOPE)")).toThrow(ParseError); // bad type
    expect(() => parse("INSERT INTO t VALUES (")).toThrow(ParseError); // truncated
  });
});
