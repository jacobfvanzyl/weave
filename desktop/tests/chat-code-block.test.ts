import { describe, expect, it } from "vitest";
import {
  canHighlightCodeFence,
  canRenderCodeMirrorFence,
  getCodeMirrorFencePath,
  isCompleteMarkdownCodeFence,
  shouldDeferCodeFenceHighlight,
} from "../../packages/client/src/components/chat/CodeBlock";

const positionForSlice = (source: string, slice: string) => {
  const start = source.indexOf(slice);
  if (start === -1) throw new Error(`Slice not found: ${slice}`);
  return {
    start: { offset: start },
    end: { offset: start + slice.length },
  };
};

describe("chat code block highlighting", () => {
  it.each([
    ["language-ts", "snippet.ts"],
    ["language-typescript", "snippet.ts"],
    ["language-tsx", "snippet.tsx"],
    ["language-js", "snippet.js"],
    ["language-javascript", "snippet.js"],
    ["language-jsx", "snippet.jsx"],
    ["language-json", "snippet.json"],
    ["language-jsonc", "snippet.jsonc"],
    ["language-css", "snippet.css"],
    ["language-scss", "snippet.scss"],
    ["language-html", "snippet.html"],
    ["language-md", "snippet.md"],
    ["language-dart", "snippet.dart"],
    ["language-yaml", "snippet.yaml"],
    ["language-yml", "snippet.yml"],
  ])("maps %s to an existing CodeMirror language path", (className, path) => {
    expect(getCodeMirrorFencePath(className)).toBe(path);
    expect(canRenderCodeMirrorFence(className)).toBe(true);
    expect(canHighlightCodeFence(className)).toBe(true);
  });

  it("ignores unrelated classes around the language class", () => {
    expect(getCodeMirrorFencePath("foo language-ts bar")).toBe("snippet.ts");
    expect(canRenderCodeMirrorFence("foo language-ts bar")).toBe(true);
    expect(canHighlightCodeFence("foo language-ts bar")).toBe(true);
  });

  it.each([
    undefined,
    "",
    "font-mono",
    "language-text",
    "language-bash",
    "language-python",
    "language-rust",
  ])("leaves unsupported or inline code unhighlighted for %s", (className) => {
    expect(getCodeMirrorFencePath(className)).toBeUndefined();
    expect(canRenderCodeMirrorFence(className)).toBe(false);
    expect(canHighlightCodeFence(className)).toBe(false);
  });

  it("keeps CodeMirror mounted but defers syntax highlighting while an assistant message is streaming", () => {
    expect(canRenderCodeMirrorFence("language-ts")).toBe(true);
    expect(canHighlightCodeFence("language-ts", true)).toBe(false);
    expect(canHighlightCodeFence("language-ts", false)).toBe(true);
  });

  it("allows completed fences in a streaming message to highlight independently", () => {
    const completedBlock = "```ts\nconst a = 1;\n```";
    const openBlock = "```js\nconst b = 2;";
    const source = `${completedBlock}\n\ntext\n${openBlock}`;

    const completedPosition = positionForSlice(source, completedBlock);
    const openPosition = positionForSlice(source, openBlock);

    expect(isCompleteMarkdownCodeFence(source, completedPosition)).toBe(true);
    expect(isCompleteMarkdownCodeFence(source, openPosition)).toBe(false);
    expect(
      shouldDeferCodeFenceHighlight(source, completedPosition, true),
    ).toBe(false);
    expect(
      shouldDeferCodeFenceHighlight(source, openPosition, true),
    ).toBe(true);
  });

  it("recognizes closed tilde fences", () => {
    const block = "~~~yaml\nname: weave\n~~~";
    expect(isCompleteMarkdownCodeFence(block, positionForSlice(block, block)))
      .toBe(true);
  });
});
