import {
  continuedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  LanguageSupport,
  LRLanguage,
} from "@codemirror/language";
import { parser } from "./parser";
import { dartHighlighting } from "./highlight";

export const dartLanguage = LRLanguage.define({
  name: "dart",
  parser: parser.configure({
    props: [
      dartHighlighting,
      indentNodeProp.add({
        Block: continuedIndent({ except: /^\s*\}/ }),
        Bracketed: continuedIndent({ except: /^\s*\]/ }),
        Parenthesized: continuedIndent({ except: /^\s*\)/ }),
      }),
      foldNodeProp.add({
        Block: foldInside,
        Bracketed: foldInside,
        Parenthesized: foldInside,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    indentOnInput: /^\s*[\}\]\)]$/,
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
  },
});

export const dart = () => new LanguageSupport(dartLanguage);
