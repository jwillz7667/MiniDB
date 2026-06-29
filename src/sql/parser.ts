import { ParseError } from "../errors.js";
import type { ColumnType } from "../record/schema.js";
import type {
  Assignment,
  CallExpr,
  ColumnDef,
  ColumnRef,
  CompareOp,
  DeleteStmt,
  Expr,
  FromClause,
  InsertStmt,
  JoinClause,
  JoinType,
  LiteralValue,
  SelectItem,
  SelectStmt,
  Statement,
  TableRef,
  UpdateStmt,
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
const COLUMN_TYPES: ReadonlySet<string> = new Set([
  "INT",
  "REAL",
  "TEXT",
  "BOOL",
  "BLOB",
  "DATETIME",
]);

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

/** Parse a single literal value (used to round-trip a stored column DEFAULT). */
export function parseLiteral(text: string): LiteralValue {
  return new Parser(tokenize(text)).readLiteralAtEnd();
}

class Parser {
  private pos = 0;
  private params = 0;

  constructor(private readonly tokens: Token[]) {}

  /** Number of `?` placeholders seen so far (final value after parsing). */
  get paramCount(): number {
    return this.params;
  }

  /** Read exactly one literal value and require the input to be fully consumed. */
  readLiteralAtEnd(): LiteralValue {
    const value = this.parseLiteralValue();
    if (!this.atEnd()) throw this.error("trailing tokens after literal");
    return value;
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
      case "DROP":
        return this.parseDrop();
      case "ALTER":
        return this.parseAlter();
      case "INSERT":
        return this.parseInsert();
      case "SELECT":
        return this.parseSelect();
      case "UPDATE":
        return this.parseUpdate();
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
      case "VACUUM":
        this.advance();
        return { kind: "vacuum" };
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
    const typeTok = this.expect("keyword", undefined, "a column type");
    if (!COLUMN_TYPES.has(typeTok.value)) {
      throw new ParseError(
        `unknown column type "${typeTok.value}" (expected one of ${[...COLUMN_TYPES].join(", ")})`,
        typeTok.line,
        typeTok.column,
      );
    }
    const type = typeTok.value as ColumnType;

    let nullable = true;
    let primaryKey = false;
    let unique = false;
    let autoIncrement = false;
    let dflt: LiteralValue | undefined;

    for (;;) {
      if (this.matchKeyword("NOT")) {
        this.expectKeyword("NULL");
        nullable = false;
      } else if (this.matchKeyword("PRIMARY")) {
        this.expectKeyword("KEY");
        primaryKey = true;
        nullable = false; // PRIMARY KEY implies NOT NULL
      } else if (this.matchKeyword("UNIQUE")) {
        unique = true;
      } else if (this.matchKeyword("AUTOINCREMENT")) {
        autoIncrement = true;
      } else if (this.matchKeyword("DEFAULT")) {
        dflt = this.parseLiteralValue();
      } else {
        break;
      }
    }
    return { name, type, nullable, primaryKey, unique, autoIncrement, default: dflt };
  }

  private parseCreateIndexBody(): Statement {
    this.expectKeyword("ON");
    const table = this.expectIdentifier("a table name");
    this.expect("punctuation", "(", '"(" before the indexed column');
    const column = this.expectIdentifier("a column name");
    this.expect("punctuation", ")", '")" after the indexed column');
    return { kind: "createIndex", table, column };
  }

  private parseDrop(): Statement {
    this.expectKeyword("DROP");
    if (this.matchKeyword("TABLE")) {
      let ifExists = false;
      if (this.matchKeyword("IF")) {
        this.expectKeyword("EXISTS");
        ifExists = true;
      }
      return { kind: "dropTable", table: this.expectIdentifier("a table name"), ifExists };
    }
    if (this.matchKeyword("INDEX")) {
      this.expectKeyword("ON");
      const table = this.expectIdentifier("a table name");
      this.expect("punctuation", "(", '"(" before the indexed column');
      const column = this.expectIdentifier("a column name");
      this.expect("punctuation", ")", '")" after the indexed column');
      return { kind: "dropIndex", table, column };
    }
    throw this.error("expected TABLE or INDEX after DROP");
  }

  private parseAlter(): Statement {
    this.expectKeyword("ALTER");
    this.expectKeyword("TABLE");
    const table = this.expectIdentifier("a table name");
    this.expectKeyword("ADD");
    this.matchKeyword("COLUMN"); // optional
    return { kind: "alterTable", table, column: this.parseColumnDef() };
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

    let columns: SelectItem[] | "*";
    if (this.match("punctuation", "*")) {
      columns = "*";
    } else {
      const list: SelectItem[] = [];
      do {
        list.push(this.parseSelectItem());
      } while (this.match("punctuation", ","));
      columns = list;
    }

    this.expectKeyword("FROM");
    const from = this.parseFrom();

    const where = this.matchKeyword("WHERE") ? this.parseExpr() : null;

    let groupBy: ColumnRef[] | null = null;
    if (this.matchKeyword("GROUP")) {
      this.expectKeyword("BY");
      const list: ColumnRef[] = [];
      do {
        list.push(this.parseColumnRef());
      } while (this.match("punctuation", ","));
      groupBy = list;
    }

    const having = this.matchKeyword("HAVING") ? this.parseExpr() : null;

    let orderBy: SelectStmt["orderBy"] = null;
    if (this.matchKeyword("ORDER")) {
      this.expectKeyword("BY");
      const column = this.parseColumnRef();
      let dir: "ASC" | "DESC" = "ASC";
      if (this.matchKeyword("DESC")) dir = "DESC";
      else this.matchKeyword("ASC"); // optional; ASC is the default
      orderBy = { column, dir };
    }

    let limit: ValueExpr | null = null;
    if (this.matchKeyword("LIMIT")) {
      limit = this.check("punctuation", "?")
        ? (this.advance(), { kind: "param", index: this.params++ })
        : { kind: "literal", value: BigInt(this.parseNonNegativeInteger()) };
    }

    return { kind: "select", columns, from, where, groupBy, having, orderBy, limit };
  }

  /** A SELECT-list item: a scalar/aggregate expression with an optional alias. */
  private parseSelectItem(): SelectItem {
    const expr = this.parsePrimary();
    if (this.matchKeyword("AS")) return { expr, alias: this.expectIdentifier("an alias after AS") };
    if (this.check("identifier")) return { expr, alias: this.advance().value };
    return { expr, alias: null };
  }

  /** A column reference, optionally qualified by a table/alias (`u.id`). */
  private parseColumnRef(): ColumnRef {
    const first = this.expectIdentifier("a column name");
    if (this.match("punctuation", ".")) {
      return { table: first, name: this.expectIdentifier('a column name after "."') };
    }
    return { table: null, name: first };
  }

  /** A FROM table with an optional alias (`users u` or `users AS u`). */
  private parseTableRef(): TableRef {
    const table = this.expectIdentifier("a table name");
    if (this.matchKeyword("AS")) return { table, alias: this.expectIdentifier("an alias after AS") };
    if (this.check("identifier")) return { table, alias: this.advance().value };
    return { table, alias: null };
  }

  private parseFrom(): FromClause {
    const base = this.parseTableRef();
    const joins: JoinClause[] = [];
    for (;;) {
      if (this.match("punctuation", ",")) {
        // Comma is a cross join; the optional WHERE turns it into an inner join.
        joins.push({ type: "inner", right: this.parseTableRef(), on: { kind: "literal", value: true } });
        continue;
      }
      let type: JoinType | null = null;
      if (this.matchKeyword("INNER")) {
        this.expectKeyword("JOIN");
        type = "inner";
      } else if (this.matchKeyword("LEFT")) {
        this.matchKeyword("OUTER"); // optional
        this.expectKeyword("JOIN");
        type = "left";
      } else if (this.matchKeyword("JOIN")) {
        type = "inner";
      }
      if (type === null) break;
      const right = this.parseTableRef();
      this.expectKeyword("ON");
      joins.push({ type, right, on: this.parseExpr() });
    }
    return { base, joins };
  }

  private parseDelete(): DeleteStmt {
    this.expectKeyword("DELETE");
    this.expectKeyword("FROM");
    const table = this.expectIdentifier("a table name");
    const where = this.matchKeyword("WHERE") ? this.parseExpr() : null;
    return { kind: "delete", table, where };
  }

  private parseUpdate(): UpdateStmt {
    this.expectKeyword("UPDATE");
    const table = this.expectIdentifier("a table name");
    this.expectKeyword("SET");

    const assignments: Assignment[] = [];
    do {
      const column = this.expectIdentifier("a column name");
      this.expect("operator", "=", '"=" in a SET assignment');
      // An assignment value is a single term (literal, ?, or column) — not a
      // comparison — so `SET a = b` reads column b rather than a boolean.
      assignments.push({ column, value: this.parsePrimary() });
    } while (this.match("punctuation", ","));

    const where = this.matchKeyword("WHERE") ? this.parseExpr() : null;
    return { kind: "update", table, assignments, where };
  }

  private parseExplain(): Statement {
    this.expectKeyword("EXPLAIN");
    const inner = this.parseStatement();
    if (
      inner.kind !== "select" &&
      inner.kind !== "insert" &&
      inner.kind !== "update" &&
      inner.kind !== "delete"
    ) {
      throw this.error("EXPLAIN only supports SELECT, INSERT, UPDATE, and DELETE");
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
      const first = this.advance().value;
      if (this.match("punctuation", "(")) return this.parseCall(first);
      if (this.match("punctuation", ".")) {
        return { kind: "column", table: first, name: this.expectIdentifier('a column name after "."') };
      }
      return { kind: "column", table: null, name: first };
    }
    return { kind: "literal", value: this.parseLiteralValue() };
  }

  /** Parse a function call's arguments after the `(` (currently aggregates only). */
  private parseCall(name: string): CallExpr {
    let star = false;
    let arg: Expr | null = null;
    if (this.match("punctuation", "*")) star = true;
    else arg = this.parseExpr();
    this.expect("punctuation", ")", '")" after a function argument');
    return { kind: "call", func: name.toLowerCase(), star, arg };
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
      const tok = this.peek();
      if (tok.type === "integer") {
        this.advance();
        return -BigInt(tok.value);
      }
      if (tok.type === "float") {
        this.advance();
        return -Number(tok.value);
      }
      throw this.error("an integer or float after -");
    }
    const t = this.peek();
    if (t.type === "integer") {
      this.advance();
      return BigInt(t.value);
    }
    if (t.type === "float") {
      this.advance();
      return Number(t.value);
    }
    if (t.type === "string") {
      this.advance();
      return t.value;
    }
    if (t.type === "blob") {
      this.advance();
      return Buffer.from(t.value, "hex");
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
