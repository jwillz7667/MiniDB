/** Token categories produced by the lexer. */
export type TokenType =
  | "keyword"
  | "identifier"
  | "integer"
  | "float"
  | "string"
  | "blob" // X'48656c6c6f' hex literal; value is the hex digits
  | "operator" // = != < <= > >=
  | "punctuation" // ( ) , * ; - ? .
  | "eof";

export interface Token {
  readonly type: TokenType;
  /** Canonical text: uppercased for keywords, raw text otherwise. */
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

/** Reserved words, stored uppercased; matched case-insensitively by the lexer. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  "CREATE",
  "TABLE",
  "INDEX",
  "ON",
  "PRIMARY",
  "KEY",
  "UNIQUE",
  "AUTOINCREMENT",
  "DEFAULT",
  "INSERT",
  "INTO",
  "VALUES",
  "SELECT",
  "FROM",
  "AS",
  "JOIN",
  "INNER",
  "LEFT",
  "OUTER",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "LIMIT",
  "DELETE",
  "UPDATE",
  "SET",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "TRUE",
  "FALSE",
  "INT",
  "REAL",
  "TEXT",
  "BOOL",
  "BLOB",
  "DATETIME",
  "EXPLAIN",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "VACUUM",
]);
