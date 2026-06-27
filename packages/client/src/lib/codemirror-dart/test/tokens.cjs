const { ExternalTokenizer } = require('@lezer/lr');
const { BlockComment, DocBlockComment, String } = require('./parser.terms.cjs');

const Slash = 47;
const Star = 42;
const Quote = 34;
const Apostrophe = 39;
const Backslash = 92;
const LowerR = 114;
const Newline = 10;
const CarriageReturn = 13;

const scanBlockComment = input => {
  if (input.next !== Slash || input.peek(1) !== Star) return false;
  const isDoc = input.peek(2) === Star;
  input.advance(2);
  let depth = 1;
  while (input.next >= 0) {
    if (input.next === Slash && input.peek(1) === Star) {
      depth += 1;
      input.advance(2);
      continue;
    }
    if (input.next === Star && input.peek(1) === Slash) {
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

const scanString = input => {
  let raw = false;
  let quote = input.next;
  if (quote === LowerR && (input.peek(1) === Quote || input.peek(1) === Apostrophe)) {
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

exports.dartTokens = new ExternalTokenizer(input => {
  scanBlockComment(input) || scanString(input);
});
