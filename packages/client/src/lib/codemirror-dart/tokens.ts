import { ExternalTokenizer, type InputStream } from "@lezer/lr";
import {
  ArgumentLabel,
  BlockComment,
  DocBlockComment,
  FunctionName,
  ParameterName,
  PropertyName,
  String as StringToken,
} from "./parser.terms";

const Slash: number = 47;
const Star: number = 42;
const Quote: number = 34;
const Apostrophe: number = 39;
const Backslash: number = 92;
const LowerR: number = 114;
const Newline: number = 10;
const CarriageReturn: number = 13;
const LeftParen: number = 40;
const Colon: number = 58;
const Comma: number = 44;
const Equal: number = 61;
const GreaterThan: number = 62;
const Question: number = 63;
const RightParen: number = 41;
const RightBrace: number = 125;
const DotChar: number = 46;
const Underscore: number = 95;
const Space: number = 32;
const Tab: number = 9;

const isLowercase = (code: number) => code >= 97 && code <= 122;
const isUppercase = (code: number) => code >= 65 && code <= 90;
const isDigit = (code: number) => code >= 48 && code <= 57;
const isIdentifierPart = (code: number) =>
  isLowercase(code) || isUppercase(code) || isDigit(code) ||
  code === Underscore;
const isHorizontalSpace = (code: number) => code === Space || code === Tab;
const isWhitespace = (code: number) =>
  isHorizontalSpace(code) || code === Newline || code === CarriageReturn;
const canEndTypeExpression = (code: number) =>
  isIdentifierPart(code) || code === GreaterThan || code === Question ||
  code === RightParen;
const reservedWords = new Set([
  "abstract",
  "as",
  "assert",
  "async",
  "await",
  "base",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "covariant",
  "default",
  "deferred",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "extension",
  "external",
  "factory",
  "false",
  "final",
  "finally",
  "for",
  "get",
  "hide",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "is",
  "late",
  "library",
  "mixin",
  "new",
  "null",
  "on",
  "operator",
  "part",
  "required",
  "rethrow",
  "return",
  "sealed",
  "set",
  "show",
  "static",
  "super",
  "switch",
  "sync",
  "this",
  "throw",
  "true",
  "try",
  "var",
  "when",
  "while",
  "with",
  "yield",
]);

const scanBlockComment = (input: InputStream) => {
  if (input.next !== Slash || input.peek(1) !== Star) return false;

  const isDoc = input.peek(2) === Star;
  input.advance(2);
  let depth = 1;
  while (input.next >= 0) {
    const next = input.next;
    const after = input.peek(1);
    if (next === Slash && after === Star) {
      depth += 1;
      input.advance(2);
      continue;
    }
    if (next === Star && after === Slash) {
      input.advance(2);
      depth -= 1;
      if (depth === 0) {
        input.acceptToken(isDoc ? DocBlockComment : BlockComment);
        return true;
      }
      continue;
    }
    input.advance();
  }

  input.acceptToken(isDoc ? DocBlockComment : BlockComment);
  return true;
};

const scanString = (input: InputStream) => {
  let raw = false;
  let quote = input.next;
  if (
    quote === LowerR &&
    (input.peek(1) === Quote || input.peek(1) === Apostrophe)
  ) {
    raw = true;
    input.advance();
    quote = input.next;
  }
  if (quote !== Quote && quote !== Apostrophe) return false;

  const triple = input.peek(1) === quote && input.peek(2) === quote;
  input.advance(triple ? 3 : 1);

  while (input.next >= 0) {
    if (!triple && (input.next === Newline || input.next === CarriageReturn)) {
      input.acceptToken(StringToken);
      return true;
    }
    if (!raw && input.next === Backslash) {
      input.advance();
      if (input.next >= 0) input.advance();
      continue;
    }
    if (input.next === quote) {
      if (triple) {
        if (input.peek(1) === quote && input.peek(2) === quote) {
          input.advance(3);
          input.acceptToken(StringToken);
          return true;
        }
      } else {
        input.advance();
        input.acceptToken(StringToken);
        return true;
      }
    }
    input.advance();
  }

  input.acceptToken(StringToken);
  return true;
};

const skipWhitespace = (input: InputStream, offset: number) => {
  while (isWhitespace(input.peek(offset))) offset += 1;
  return offset;
};

const skipIdentifier = (input: InputStream, offset: number) => {
  if (!isLowercase(input.peek(offset)) && input.peek(offset) !== Underscore) {
    return -1;
  }
  offset += 1;
  while (isIdentifierPart(input.peek(offset))) offset += 1;
  return offset;
};

const isLambdaParameterTail = (input: InputStream) => {
  let offset = 0;
  while (true) {
    offset = skipWhitespace(input, offset);
    const next = input.peek(offset);
    if (next === Comma) {
      offset = skipWhitespace(input, offset + 1);
      offset = skipIdentifier(input, offset);
      if (offset < 0) return false;
      continue;
    }
    if (next !== RightParen) return false;

    offset = skipWhitespace(input, offset + 1);
    return input.peek(offset) === Equal &&
      input.peek(offset + 1) === GreaterThan;
  }
};

const scanIdentifierRole = (input: InputStream) => {
  if (!isLowercase(input.next) && input.next !== Underscore) return false;

  let lookBehindOffset = -1;
  const followsSpace = isHorizontalSpace(input.peek(lookBehindOffset));
  while (isHorizontalSpace(input.peek(lookBehindOffset))) lookBehindOffset -= 1;
  const previousNonSpace = input.peek(lookBehindOffset);

  let word = String.fromCharCode(input.next);
  input.advance();
  while (isIdentifierPart(input.next)) {
    word += String.fromCharCode(input.next);
    input.advance();
  }

  if (
    input.next === LeftParen &&
    (previousNonSpace === DotChar || !reservedWords.has(word))
  ) {
    input.acceptToken(FunctionName);
    return true;
  }
  if (previousNonSpace === DotChar) {
    input.acceptToken(PropertyName);
    return true;
  }
  if (input.next === Colon) {
    input.acceptToken(ArgumentLabel);
    return true;
  }
  if (
    (previousNonSpace === LeftParen || previousNonSpace === Comma) &&
    isLambdaParameterTail(input)
  ) {
    input.acceptToken(ParameterName);
    return true;
  }
  if (
    followsSpace &&
    canEndTypeExpression(previousNonSpace) &&
    (input.next === Comma || input.next === RightParen ||
      input.next === RightBrace)
  ) {
    input.acceptToken(ParameterName);
    return true;
  }
  return false;
};

export const dartTokens = new ExternalTokenizer((input) => {
  scanBlockComment(input) || scanString(input) || scanIdentifierRole(input);
});
