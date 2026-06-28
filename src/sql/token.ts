/** Token categories produced by the lexer. */
export type TokenType =
  | "keyword"
  | "identifier"
  | "integer"
  | "string"
  | "operator" // = != < <= > >=
  | "punctuation" // ( ) , * ; -
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
  "INSERT",
  "INTO",
  "VALUES",
  "SELECT",
  "FROM",
  "WHERE",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "LIMIT",
  "DELETE",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "TRUE",
  "FALSE",
  "INT",
  "TEXT",
  "BOOL",
  "EXPLAIN",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
]);
