import type { CoppermindJupyterOutput } from "./coppermind-jupyter";

export type CoppermindCodeCellOutput = CoppermindJupyterOutput & {
  outputId: string;
};

export type CoppermindCodeCellOutputsPayload = {
  version: 1;
  outputs: CoppermindCodeCellOutput[];
};

export type JupyterOutputRendererKind =
  | "stream"
  | "error"
  | "image"
  | "json"
  | "html"
  | "markdown"
  | "text"
  | "unknown";

export type JupyterAnsiStyle = {
  background?: string;
  bold?: boolean;
  faint?: boolean;
  foreground?: string;
  inverse?: boolean;
  italic?: boolean;
  underline?: boolean;
};

export type JupyterAnsiSegment = {
  style?: JupyterAnsiStyle;
  text: string;
};

export type JupyterMarkdownImage = {
  alt: string;
  src: string;
  title?: string;
};

export const emptyCoppermindCodeCellOutputs =
  (): CoppermindCodeCellOutputsPayload => ({
    outputs: [],
    version: 1,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const toText = (value: unknown) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join("");
  return value === undefined || value === null ? "" : String(value);
};

const normalizeMimeBundle = (value: unknown): Record<string, unknown> => (
  isRecord(value) ? value : {}
);

type JupyterAnsiCell = {
  char: string;
  style: JupyterAnsiStyle;
};

const ansi16Colors = [
  "var(--vscode-terminal-ansiBlack, #45475a)",
  "var(--vscode-terminal-ansiRed, #f38ba8)",
  "var(--vscode-terminal-ansiGreen, #a6e3a1)",
  "var(--vscode-terminal-ansiYellow, #f9e2af)",
  "var(--vscode-terminal-ansiBlue, #89b4fa)",
  "var(--vscode-terminal-ansiMagenta, #f5c2e7)",
  "var(--vscode-terminal-ansiCyan, #94e2d5)",
  "var(--vscode-terminal-ansiWhite, #a6adc8)",
  "var(--vscode-terminal-ansiBrightBlack, #585b70)",
  "var(--vscode-terminal-ansiBrightRed, #f38ba8)",
  "var(--vscode-terminal-ansiBrightGreen, #a6e3a1)",
  "var(--vscode-terminal-ansiBrightYellow, #f9e2af)",
  "var(--vscode-terminal-ansiBrightBlue, #89b4fa)",
  "var(--vscode-terminal-ansiBrightMagenta, #f5c2e7)",
  "var(--vscode-terminal-ansiBrightCyan, #94e2d5)",
  "var(--vscode-terminal-ansiBrightWhite, #bac2de)",
];

const cloneAnsiStyle = (style: JupyterAnsiStyle): JupyterAnsiStyle => ({
  ...style,
});

const isEmptyAnsiStyle = (style: JupyterAnsiStyle | undefined) => (
  !style || Object.keys(style).length === 0
);

const ansiStylesEqual = (
  left: JupyterAnsiStyle | undefined,
  right: JupyterAnsiStyle | undefined,
) => (
  (left?.background ?? "") === (right?.background ?? "") &&
  Boolean(left?.bold) === Boolean(right?.bold) &&
  Boolean(left?.faint) === Boolean(right?.faint) &&
  (left?.foreground ?? "") === (right?.foreground ?? "") &&
  Boolean(left?.inverse) === Boolean(right?.inverse) &&
  Boolean(left?.italic) === Boolean(right?.italic) &&
  Boolean(left?.underline) === Boolean(right?.underline)
);

const ansi256Color = (value: number) => {
  if (value >= 0 && value < ansi16Colors.length) return ansi16Colors[value];
  if (value >= 16 && value <= 231) {
    const offset = value - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(offset / 36)] ?? 0;
    const green = levels[Math.floor((offset % 36) / 6)] ?? 0;
    const blue = levels[offset % 6] ?? 0;
    return `rgb(${red}, ${green}, ${blue})`;
  }
  if (value >= 232 && value <= 255) {
    const level = 8 + (value - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  return undefined;
};

const rgbColor = (
  red: number | undefined,
  green: number | undefined,
  blue: number | undefined,
) => {
  if (
    red === undefined || green === undefined || blue === undefined ||
    red < 0 || green < 0 || blue < 0 ||
    red > 255 || green > 255 || blue > 255
  ) {
    return undefined;
  }
  return `rgb(${red}, ${green}, ${blue})`;
};

const parseCsiParameters = (value: string) => {
  if (!value) return [0];
  return value
    .split(/[;:]/)
    .map((part) => part === "" ? 0 : Number.parseInt(part, 10))
    .filter(Number.isFinite);
};

const csiMovementCount = (parameters: number[]) =>
  Math.max(1, parameters[0] ?? 1);

const applyAnsiSgrCodes = (style: JupyterAnsiStyle, codes: number[]) => {
  let next = cloneAnsiStyle(style);
  const values = codes.length ? codes : [0];
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index] ?? 0;
    if (code === 0) {
      next = {};
    } else if (code === 1) {
      next.bold = true;
      delete next.faint;
    } else if (code === 2) {
      next.faint = true;
      delete next.bold;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 22) {
      delete next.bold;
      delete next.faint;
    } else if (code === 23) {
      delete next.italic;
    } else if (code === 24) {
      delete next.underline;
    } else if (code === 27) {
      delete next.inverse;
    } else if (code >= 30 && code <= 37) {
      next.foreground = ansi16Colors[code - 30];
    } else if (code === 39) {
      delete next.foreground;
    } else if (code >= 40 && code <= 47) {
      next.background = ansi16Colors[code - 40];
    } else if (code === 49) {
      delete next.background;
    } else if (code >= 90 && code <= 97) {
      next.foreground = ansi16Colors[8 + code - 90];
    } else if (code >= 100 && code <= 107) {
      next.background = ansi16Colors[8 + code - 100];
    } else if (code === 38 || code === 48) {
      const property = code === 38 ? "foreground" : "background";
      const mode = values[index + 1];
      if (mode === 5) {
        const color = ansi256Color(values[index + 2] ?? -1);
        if (color) next[property] = color;
        index += 2;
      } else if (mode === 2) {
        const color = rgbColor(
          values[index + 2],
          values[index + 3],
          values[index + 4],
        );
        if (color) next[property] = color;
        index += 4;
      }
    }
  }
  return next;
};

const pushAnsiSegment = (
  segments: JupyterAnsiSegment[],
  text: string,
  style: JupyterAnsiStyle,
) => {
  if (!text) return;
  const segmentStyle = isEmptyAnsiStyle(style)
    ? undefined
    : cloneAnsiStyle(style);
  const previous = segments[segments.length - 1];
  if (previous && ansiStylesEqual(previous.style, segmentStyle)) {
    previous.text += text;
  } else {
    segments.push(segmentStyle ? { style: segmentStyle, text } : { text });
  }
};

const flattenAnsiCells = (lines: JupyterAnsiCell[][]) => {
  const segments: JupyterAnsiSegment[] = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) pushAnsiSegment(segments, "\n", {});
    for (const cell of line) pushAnsiSegment(segments, cell.char, cell.style);
  });
  return segments;
};

const trimTrailingEmptyAnsiLines = (lines: JupyterAnsiCell[][]) => {
  const trimmed = [...lines];
  while (
    trimmed.length > 1 && (trimmed[trimmed.length - 1]?.length ?? 0) === 0
  ) {
    trimmed.pop();
  }
  return trimmed;
};

export const parseJupyterAnsiText = (value: unknown): JupyterAnsiSegment[] => {
  const text = toText(value);
  const lines: JupyterAnsiCell[][] = [[]];
  let row = 0;
  let column = 0;
  let style: JupyterAnsiStyle = {};
  let trimTrailingCursorRows = false;

  const line = () => lines[row] ?? (lines[row] = []);
  const moveToRow = (nextRow: number) => {
    row = Math.max(0, nextRow);
    while (lines.length <= row) lines.push([]);
  };
  const write = (char: string) => {
    const current = line();
    while (current.length < column) current.push({ char: " ", style: {} });
    current[column] = { char, style: cloneAnsiStyle(style) };
    column += 1;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\x1b") {
      const next = text[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < text.length) {
          const code = text.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end += 1;
        }
        if (end >= text.length) break;
        const final = text[end];
        const parameters = parseCsiParameters(text.slice(index + 2, end));
        if (final === "m") {
          style = applyAnsiSgrCodes(style, parameters);
        } else if (final === "K") {
          const mode = parameters[0] ?? 0;
          const current = line();
          if (mode === 1) {
            for (
              let position = 0;
              position <= Math.min(column, current.length - 1);
              position += 1
            ) {
              current[position] = { char: " ", style: {} };
            }
          } else if (mode === 2) {
            current.length = 0;
          } else {
            current.splice(column);
          }
        } else if (final === "A") {
          moveToRow(row - csiMovementCount(parameters));
          trimTrailingCursorRows = true;
        } else if (final === "B") {
          moveToRow(row + csiMovementCount(parameters));
        } else if (final === "E") {
          moveToRow(row + csiMovementCount(parameters));
          column = 0;
        } else if (final === "F") {
          moveToRow(row - csiMovementCount(parameters));
          column = 0;
          trimTrailingCursorRows = true;
        }
        index = end + 1;
        continue;
      }
      if (next === "]") {
        let end = index + 2;
        while (end < text.length) {
          if (text[end] === "\x07") {
            end += 1;
            break;
          }
          if (text[end] === "\x1b" && text[end + 1] === "\\") {
            end += 2;
            break;
          }
          end += 1;
        }
        index = end;
        continue;
      }
      index += next ? 2 : 1;
      continue;
    }

    if (char === "\r") {
      column = 0;
    } else if (char === "\n") {
      row += 1;
      column = 0;
      if (!lines[row]) lines[row] = [];
    } else if (char === "\b") {
      column = Math.max(0, column - 1);
    } else if (char === "\t") {
      write(char);
    } else if (
      char && (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
    ) {
      // Drop unsupported control characters instead of rendering them literally.
    } else if (char) {
      write(char);
    }
    index += 1;
  }

  return flattenAnsiCells(
    trimTrailingCursorRows ? trimTrailingEmptyAnsiLines(lines) : lines,
  );
};

export const getJupyterAnsiPlainText = (value: unknown) => (
  parseJupyterAnsiText(value).map((segment) => segment.text).join("")
);

export const normalizeJupyterOutput = (
  output: CoppermindJupyterOutput,
  outputId = `out:${crypto.randomUUID()}`,
): CoppermindCodeCellOutput => {
  if (output.output_type === "stream") {
    return {
      outputId,
      output_type: "stream",
      name: output.name || "stdout",
      text: toText(output.text),
    };
  }
  if (output.output_type === "error") {
    return {
      outputId,
      output_type: "error",
      ename: toText(output.ename),
      evalue: toText(output.evalue),
      traceback: stringArray(output.traceback),
    };
  }
  if (output.output_type === "display_data") {
    return {
      outputId,
      output_type: "display_data",
      data: normalizeMimeBundle(output.data),
      ...(isRecord(output.metadata) ? { metadata: output.metadata } : {}),
      ...(isRecord(output.transient) ? { transient: output.transient } : {}),
    };
  }
  return {
    outputId,
    output_type: "execute_result",
    execution_count: typeof output.execution_count === "number"
      ? output.execution_count
      : null,
    data: normalizeMimeBundle(output.data),
    ...(isRecord(output.metadata) ? { metadata: output.metadata } : {}),
  };
};

export const parseCoppermindCodeCellOutputs = (
  value: unknown,
): CoppermindCodeCellOutputsPayload => {
  if (typeof value !== "string" || !value.trim()) {
    return emptyCoppermindCodeCellOutputs();
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) || parsed.version !== 1 ||
      !Array.isArray(parsed.outputs)
    ) {
      return emptyCoppermindCodeCellOutputs();
    }

    return {
      version: 1,
      outputs: parsed.outputs.flatMap(
        (item, index): CoppermindCodeCellOutput[] => {
          if (!isRecord(item) || typeof item.output_type !== "string") {
            return [];
          }
          const outputId = typeof item.outputId === "string" && item.outputId
            ? item.outputId
            : `out:${index}`;
          if (item.output_type === "stream") {
            return [{
              outputId,
              output_type: "stream",
              name: toText(item.name) || "stdout",
              text: toText(item.text),
            }];
          }
          if (item.output_type === "error") {
            return [{
              outputId,
              output_type: "error",
              ename: toText(item.ename),
              evalue: toText(item.evalue),
              traceback: stringArray(item.traceback),
            }];
          }
          if (item.output_type === "display_data") {
            return [{
              outputId,
              output_type: "display_data",
              data: normalizeMimeBundle(item.data),
              ...(isRecord(item.metadata) ? { metadata: item.metadata } : {}),
              ...(isRecord(item.transient)
                ? { transient: item.transient }
                : {}),
            }];
          }
          if (item.output_type === "execute_result") {
            return [{
              outputId,
              output_type: "execute_result",
              execution_count: typeof item.execution_count === "number"
                ? item.execution_count
                : null,
              data: normalizeMimeBundle(item.data),
              ...(isRecord(item.metadata) ? { metadata: item.metadata } : {}),
            }];
          }
          return [];
        },
      ),
    };
  } catch {
    return emptyCoppermindCodeCellOutputs();
  }
};

export const serializeCoppermindCodeCellOutputs = (
  outputs: CoppermindCodeCellOutput[],
) =>
  JSON.stringify(
    { outputs, version: 1 } satisfies CoppermindCodeCellOutputsPayload,
  );

export const appendJupyterOutput = (
  current: CoppermindCodeCellOutput[],
  output: CoppermindJupyterOutput,
  outputId?: string,
) => {
  const normalized = normalizeJupyterOutput(output, outputId);
  const previous = current[current.length - 1];
  if (
    previous?.output_type === "stream" &&
    normalized.output_type === "stream" &&
    previous.name === normalized.name
  ) {
    return [
      ...current.slice(0, -1),
      { ...previous, text: `${previous.text}${normalized.text}` },
    ];
  }
  return [...current, normalized];
};

export const getMimeBundleText = (data: Record<string, unknown>) => {
  const text = data["text/plain"];
  if (Array.isArray(text)) return text.map((item) => String(item)).join("");
  return typeof text === "string" ? text : undefined;
};

const standaloneMarkdownImagePattern =
  /^!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]+>|[^\s)\n]+)(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?\s*\)$/;

const unescapeMarkdownInlineText = (value: string) =>
  value.replace(/\\([\\[\]()`*_{}#+\-.!])/g, "$1");

export const extractJupyterMarkdownImage = (
  value: unknown,
): JupyterMarkdownImage | undefined => {
  const markdown = toText(value).trim();
  const match = markdown.match(standaloneMarkdownImagePattern);
  if (!match) return undefined;

  const source = (match[2] ?? "").trim();
  const src = source.startsWith("<") && source.endsWith(">")
    ? source.slice(1, -1).trim()
    : source;
  if (!src.toLowerCase().startsWith("data:image/")) return undefined;

  const title = match[3] ?? match[4] ?? match[5];
  return {
    alt: unescapeMarkdownInlineText(match[1] ?? ""),
    src,
    ...(title ? { title: unescapeMarkdownInlineText(title) } : {}),
  };
};

export const getPreferredMimeType = (data: Record<string, unknown>) => {
  if (typeof data["image/png"] === "string") return "image/png";
  if (typeof data["image/jpeg"] === "string") return "image/jpeg";
  if (typeof data["image/svg+xml"] === "string") return "image/svg+xml";
  if (data["application/json"] !== undefined) return "application/json";
  if (data["application/vnd.jupyter.widget-view+json"] !== undefined) {
    return "application/vnd.jupyter.widget-view+json";
  }
  if (typeof data["text/html"] === "string") return "text/html";
  if (typeof data["text/markdown"] === "string") return "text/markdown";
  if (data["text/plain"] !== undefined) return "text/plain";
  return undefined;
};

export const getJupyterOutputRendererKind = (
  output: CoppermindCodeCellOutput,
): JupyterOutputRendererKind => {
  if (output.output_type === "stream") return "stream";
  if (output.output_type === "error") return "error";
  const mimeType = getPreferredMimeType(output.data);
  if (
    mimeType === "image/png" || mimeType === "image/jpeg" ||
    mimeType === "image/svg+xml"
  ) return "image";
  if (mimeType === "application/json") return "json";
  if (mimeType === "text/html") return "html";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/plain") return "text";
  return "unknown";
};
