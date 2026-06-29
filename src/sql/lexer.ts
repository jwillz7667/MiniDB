import { LexError } from "../errors.js";
import { KEYWORDS, type Token, type TokenType } from "./token.js";

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isAlphaNum = (c: string): boolean => isAlpha(c) || isDigit(c);

/**
 * Hand-written lexer. Case-insensitive keywords, single-quoted strings (with ''
 * to embed a quote), `--` line comments, and 1-based line/column tracking so
 * errors can point at the offending character.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 1;

  const peek = (ahead = 0): string => source[pos + ahead] ?? "";
  const advance = (): string => {
    const c = source[pos++]!;
    if (c === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return c;
  };

  while (pos < source.length) {
    const c = peek();

    // Whitespace.
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance();
      continue;
    }

    // Line comment: -- ... end of line.
    if (c === "-" && peek(1) === "-") {
      while (pos < source.length && peek() !== "\n") advance();
      continue;
    }

    const startLine = line;
    const startColumn = column;
    const push = (type: TokenType, value: string): void => {
      tokens.push({ type, value, line: startLine, column: startColumn });
    };

    // Blob hex literal: X'48656c6c6f'. Must precede the identifier rule so a
    // lone `x`/`X` followed by a quote is read as a blob, not an identifier.
    if ((c === "X" || c === "x") && peek(1) === "'") {
      advance(); // X / x
      advance(); // opening quote
      let hex = "";
      for (;;) {
        if (pos >= source.length) {
          throw new LexError("unterminated blob literal", startLine, startColumn);
        }
        const ch = advance();
        if (ch === "'") break;
        hex += ch;
      }
      if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
        throw new LexError(`invalid blob literal X'${hex}'`, startLine, startColumn);
      }
      push("blob", hex);
      continue;
    }

    // Identifier or keyword.
    if (isAlpha(c)) {
      let text = "";
      while (pos < source.length && isAlphaNum(peek())) text += advance();
      const upper = text.toUpperCase();
      if (KEYWORDS.has(upper)) push("keyword", upper);
      else push("identifier", text);
      continue;
    }

    // Numeric literal: integer, or a float with a fraction and/or exponent.
    if (isDigit(c)) {
      let text = "";
      let isFloat = false;
      while (pos < source.length && isDigit(peek())) text += advance();
      if (peek() === "." && isDigit(peek(1))) {
        isFloat = true;
        text += advance(); // "."
        while (pos < source.length && isDigit(peek())) text += advance();
      }
      if (peek() === "e" || peek() === "E") {
        isFloat = true;
        text += advance(); // "e" / "E"
        if (peek() === "+" || peek() === "-") text += advance();
        if (!isDigit(peek())) {
          throw new LexError(`invalid exponent in number near "${text}"`, line, column);
        }
        while (pos < source.length && isDigit(peek())) text += advance();
      }
      if (isAlpha(peek())) {
        throw new LexError(`invalid number literal near "${text}${peek()}"`, line, column);
      }
      push(isFloat ? "float" : "integer", text);
      continue;
    }

    // String literal.
    if (c === "'") {
      advance(); // opening quote
      let text = "";
      for (;;) {
        if (pos >= source.length) {
          throw new LexError("unterminated string literal", startLine, startColumn);
        }
        const ch = advance();
        if (ch === "'") {
          if (peek() === "'") {
            text += advance(); // escaped quote ''
            continue;
          }
          break; // closing quote
        }
        text += ch;
      }
      push("string", text);
      continue;
    }

    // Comparison operators.
    if (c === "=") {
      advance();
      push("operator", "=");
      continue;
    }
    if (c === "!") {
      advance();
      if (peek() !== "=") throw new LexError('expected "=" after "!"', line, column);
      advance();
      push("operator", "!=");
      continue;
    }
    if (c === "<") {
      advance();
      if (peek() === "=") {
        advance();
        push("operator", "<=");
      } else {
        push("operator", "<");
      }
      continue;
    }
    if (c === ">") {
      advance();
      if (peek() === "=") {
        advance();
        push("operator", ">=");
      } else {
        push("operator", ">");
      }
      continue;
    }

    // Punctuation. "?" is a positional bind placeholder; "." qualifies columns.
    if (
      c === "(" ||
      c === ")" ||
      c === "," ||
      c === "*" ||
      c === ";" ||
      c === "-" ||
      c === "?" ||
      c === "."
    ) {
      advance();
      push("punctuation", c);
      continue;
    }

    throw new LexError(`unexpected character "${c}"`, line, column);
  }

  tokens.push({ type: "eof", value: "", line, column });
  return tokens;
}
