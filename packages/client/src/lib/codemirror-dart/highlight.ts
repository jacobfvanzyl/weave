import { styleTags, tags as t } from "@lezer/highlight";

export const dartHighlighting = styleTags({
  "Keyword/...": t.keyword,
  BuiltinType: t.typeName,
  Boolean: t.bool,
  Null: t.null,
  TypeIdentifier: t.typeName,
  Identifier: t.variableName,
  Annotation: t.annotation,
  String: t.string,
  Number: t.number,
  RecordField: t.propertyName,
  "LineComment DocLineComment": t.lineComment,
  "BlockComment DocBlockComment": t.blockComment,
  Operator: t.operator,
  "Dot Punctuation": t.separator,
});
