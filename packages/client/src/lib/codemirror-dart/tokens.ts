import { ExternalTokenizer, type InputStream } from "@lezer/lr";
import { BlockComment, DocBlockComment, String } from "./parser.terms";

const Slash: number = 47;
const Star: number = 42;
const Quote: number = 34;
const Apostrophe: number = 39;
const Backslash: number = 92;
const LowerR: number = 114;
const Newline: number = 10;
const CarriageReturn: number = 13;

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
      input.acceptToken(String);
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
          input.acceptToken(String);
          return true;
        }
      } else {
        input.advance();
        input.acceptToken(String);
        return true;
      }
    }
    input.advance();
  }

  input.acceptToken(String);
  return true;
};

export const dartTokens = new ExternalTokenizer((input) => {
  scanBlockComment(input) || scanString(input);
});
