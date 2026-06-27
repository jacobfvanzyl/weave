import { styleTags, tags as t } from "@lezer/highlight";

export const dartHighlighting = styleTags({
  "Annotation!": t.atom,
  "Keyword/this Keyword/super": t.self,
  "Keyword/...": t.keyword,
  FunctionName: t.function(t.variableName),
  PropertyName: t.propertyName,
  ParameterName: t.special(t.variableName),
  ArgumentLabel: t.special(t.variableName),
  BuiltinType: t.typeName,
  Boolean: t.bool,
  Null: t.null,
  TypeIdentifier: t.typeName,
  Identifier: t.variableName,
  String: t.string,
  Number: t.number,
  RecordField: t.propertyName,
  "LineComment DocLineComment": t.lineComment,
  "BlockComment DocBlockComment": t.blockComment,
  Operator: t.operator,
  "Dot Punctuation": t.separator,
});
