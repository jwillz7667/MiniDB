import { ParseError } from "../errors.js";
import type { ColumnType } from "../record/schema.js";
import type {
  ColumnDef,
  CompareOp,
  DeleteStmt,
  Expr,
  InsertStmt,
  LiteralValue,
  SelectStmt,
  Statement,
  ValueExpr,
} from "./ast.js";
import { tokenize } from "./lexer.js";
import type { Token, TokenType } from "./token.js";

/** A parsed statement together with the number of `?` placeholders it carries. */
export interface ParsedStatement {
  readonly statement: Statement;
  readonly paramCount: number;
}

/**
 * Parse exactly one statement and report its placeholder count, for the
 * prepared-statement path (`Database.prepare`). The returned AST may contain
 * `param` nodes; `bindStatement` substitutes them before planning.
 */
export function parsePrepared(sql: string): ParsedStatement {
  const parser = new Parser(tokenize(sql));
  const statements = parser.parseProgram();
  if (statements.length === 0) throw new ParseError("empty statement", 1, 1);
  if (statements.length > 1) {
    throw new ParseError(`expected a single statement but found ${statements.length}`, 1, 1);
  }
  return { statement: statements[0]!, paramCount: parser.paramCount };
}

const COMPARE_OPS: ReadonlySet<string> = new Set(["=", "!=", "<", "<=", ">", ">="]);
const COLUMN_TYPES: ReadonlySet<string> = new Set(["INT", "TEXT", "BOOL"]);

/** Parse exactly one statement (a trailing `;` is allowed). */
export function parse(sql: string): Statement {
  const statements = parseMany(sql);
  if (statements.length === 0) throw new ParseError("empty statement", 1, 1);
  if (statements.length > 1) {
    throw new ParseError(`expected a single statement but found ${statements.length}`, 1, 1);
  }
  return statements[0]!;
}

/** Parse a program of `;`-separated statements. */
export function parseMany(sql: string): Statement[] {
  return new Parser(tokenize(sql)).parseProgram();
}

class Parser {
  private pos = 0;
  private params = 0;

  constructor(private readonly tokens: Token[]) {}

  /** Number of `?` placeholders seen so far (final value after parsing). */
  get paramCount(): number {
    return this.params;
  }

  parseProgram(): Statement[] {
    const out: Statement[] = [];
    while (!this.atEnd()) {
      if (this.match("punctuation", ";")) continue; // tolerate stray/empty separators
      out.push(this.parseStatement());
      if (!this.atEnd() && !this.match("punctuation", ";")) {
        throw this.error('expected ";" or end of input');
      }
    }
    return out;
  }

  // ---- token helpers ------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private atEnd(): boolean {
    return this.peek().type === "eof";
  }

  private advance(): Token {
    const t = this.tokens[this.pos]!;
    if (t.type !== "eof") this.pos += 1;
    return t;
  }

  private check(type: TokenType, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }

  private match(type: TokenType, value?: string): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchKeyword(kw: string): boolean {
    return this.match("keyword", kw);
  }

  private expect(type: TokenType, value: string | undefined, what: string): Token {
    if (this.check(type, value)) return this.advance();
    throw this.error(`expected ${what}`);
  }

  private expectKeyword(kw: string): Token {
    return this.expect("keyword", kw, `keyword ${kw}`);
  }

  private expectIdentifier(what = "an identifier"): string {
    return this.expect("identifier", undefined, what).value;
  }

  private error(message: string): ParseError {
    const t = this.peek();
    const found = t.type === "eof" ? "end of input" : `"${t.value}" (${t.type})`;
    return new ParseError(`${message} but found ${found}`, t.line, t.column);
  }

  // ---- statements ---------------------------------------------------------

  private parseStatement(): Statement {
    const t = this.peek();
    if (t.type !== "keyword") throw this.error("expected a SQL statement");
    switch (t.value) {
      case "CREATE":
        return this.parseCreate();
      case "INSERT":
        return this.parseInsert();
      case "SELECT":
        return this.parseSelect();
      case "DELETE":
        return this.parseDelete();
      case "EXPLAIN":
        return this.parseExplain();
      case "BEGIN":
        this.advance();
        return { kind: "begin" };
      case "COMMIT":
        this.advance();
        return { kind: "commit" };
      case "ROLLBACK":
        this.advance();
        return { kind: "rollback" };
      default:
        throw this.error("expected a SQL statement");
    }
  }

  private parseCreate(): Statement {
    this.expectKeyword("CREATE");
    if (this.matchKeyword("TABLE")) return this.parseCreateTableBody();
    if (this.matchKeyword("INDEX")) return this.parseCreateIndexBody();
    throw this.error("expected TABLE or INDEX after CREATE");
  }

  private parseCreateTableBody(): Statement {
    const table = this.expectIdentifier("a table name");
    this.expect("punctuation", "(", '"(" before column list');
    const columns: ColumnDef[] = [];
    do {
      columns.push(this.parseColumnDef());
    } while (this.match("punctuation", ","));
    this.expect("punctuation", ")", '")" after column list');
    return { kind: "createTable", table, columns };
  }

  private parseColumnDef(): ColumnDef {
    const name = this.expectIdentifier("a column name");
    const typeTok = this.expect("keyword", undefined, "a column type (INT, TEXT, BOOL)");
    if (!COLUMN_TYPES.has(typeTok.value)) {
      throw new ParseError(
        `unknown column type "${typeTok.value}" (expected INT, TEXT, or BOOL)`,
        typeTok.line,
        typeTok.column,
      );
    }
    let nullable = true;
    if (this.matchKeyword("NOT")) {
      this.expectKeyword("NULL");
      nullable = false;
    }
    return { name, type: typeTok.value as ColumnType, nullable };
  }

  private parseCreateIndexBody(): Statement {
    this.expectKeyword("ON");
    const table = this.expectIdentifier("a table name");
    this.expect("punctuation", "(", '"(" before the indexed column');
    const column = this.expectIdentifier("a column name");
    this.expect("punctuation", ")", '")" after the indexed column');
    return { kind: "createIndex", table, column };
  }

  private parseInsert(): InsertStmt {
    this.expectKeyword("INSERT");
    this.expectKeyword("INTO");
    const table = this.expectIdentifier("a table name");

    let columns: string[] | null = null;
    if (this.match("punctuation", "(")) {
      columns = [];
      do {
        columns.push(this.expectIdentifier("a column name"));
      } while (this.match("punctuation", ","));
      this.expect("punctuation", ")", '")" after column list');
    }

    this.expectKeyword("VALUES");
    const rows: ValueExpr[][] = [];
    do {
      this.expect("punctuation", "(", '"(" before a value tuple');
      const values: ValueExpr[] = [];
      do {
        values.push(this.parseValueExpr());
      } while (this.match("punctuation", ","));
      this.expect("punctuation", ")", '")" after a value tuple');
      rows.push(values);
    } while (this.match("punctuation", ","));

    return { kind: "insert", table, columns, rows };
  }

  private parseSelect(): SelectStmt {
    this.expectKeyword("SELECT");

    let columns: string[] | "*";
    if (this.match("punctuation", "*")) {
      columns = "*";
    } else {
      const list: string[] = [];
      do {
        list.push(this.expectIdentifier("a column name or *"));
      } while (this.match("punctuation", ","));
      columns = list;
    }

    this.expectKeyword("FROM");
    const table = this.expectIdentifier("a table name");

    const where = this.matchKeyword("WHERE") ? this.parseExpr() : null;

    let orderBy: SelectStmt["orderBy"] = null;
    if (this.matchKeyword("ORDER")) {
      this.expectKeyword("BY");
      const column = this.expectIdentifier("a column name");
      let dir: "ASC" | "DESC" = "ASC";
      if (this.matchKeyword("DESC")) dir = "DESC";
      else this.matchKeyword("ASC"); // optional; ASC is the default
      orderBy = { column, dir };
    }

    let limit: number | null = null;
    if (this.matchKeyword("LIMIT")) {
      limit = this.parseNonNegativeInteger();
    }

    return { kind: "select", columns, table, where, orderBy, limit };
  }

  private parseDelete(): DeleteStmt {
    this.expectKeyword("DELETE");
    this.expectKeyword("FROM");
    const table = this.expectIdentifier("a table name");
    const where = this.matchKeyword("WHERE") ? this.parseExpr() : null;
    return { kind: "delete", table, where };
  }

  private parseExplain(): Statement {
    this.expectKeyword("EXPLAIN");
    const inner = this.parseStatement();
    if (inner.kind !== "select" && inner.kind !== "insert" && inner.kind !== "delete") {
      throw this.error("EXPLAIN only supports SELECT, INSERT, and DELETE");
    }
    return { kind: "explain", statement: inner };
  }

  // ---- expressions (precedence: OR < AND < comparison < primary) ----------

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchKeyword("OR")) {
      left = { kind: "logical", op: "OR", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.matchKeyword("AND")) {
      left = { kind: "logical", op: "AND", left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): Expr {
    const left = this.parsePrimary();
    if (this.peek().type === "operator" && COMPARE_OPS.has(this.peek().value)) {
      const op = this.advance().value as CompareOp;
      return { kind: "compare", op, left, right: this.parsePrimary() };
    }
    return left;
  }

  private parsePrimary(): Expr {
    if (this.match("punctuation", "(")) {
      const expr = this.parseExpr();
      this.expect("punctuation", ")", '")" to close a grouped expression');
      return expr;
    }
    if (this.check("punctuation", "?")) {
      this.advance();
      return { kind: "param", index: this.params++ };
    }
    if (this.check("identifier")) {
      return { kind: "column", name: this.advance().value };
    }
    return { kind: "literal", value: this.parseLiteralValue() };
  }

  /** A literal or a `?` placeholder, for value positions (INSERT/UPDATE). */
  private parseValueExpr(): ValueExpr {
    if (this.check("punctuation", "?")) {
      this.advance();
      return { kind: "param", index: this.params++ };
    }
    return { kind: "literal", value: this.parseLiteralValue() };
  }

  private parseLiteralValue(): LiteralValue {
    if (this.match("punctuation", "-")) {
      const tok = this.expect("integer", undefined, "an integer after -");
      return -BigInt(tok.value);
    }
    const t = this.peek();
    if (t.type === "integer") {
      this.advance();
      return BigInt(t.value);
    }
    if (t.type === "string") {
      this.advance();
      return t.value;
    }
    if (t.type === "keyword") {
      switch (t.value) {
        case "TRUE":
          this.advance();
          return true;
        case "FALSE":
          this.advance();
          return false;
        case "NULL":
          this.advance();
          return null;
      }
    }
    throw this.error("expected a literal value");
  }

  private parseNonNegativeInteger(): number {
    const tok = this.expect("integer", undefined, "a non-negative integer");
    const n = Number(tok.value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new ParseError(`invalid count "${tok.value}"`, tok.line, tok.column);
    }
    return n;
  }
}
