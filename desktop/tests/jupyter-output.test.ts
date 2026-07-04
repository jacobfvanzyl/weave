import { describe, expect, it } from "vitest";
import {
  appendJupyterOutput,
  type CoppermindCodeCellOutput,
  extractJupyterMarkdownImage,
  getJupyterAnsiPlainText,
  getJupyterOutputRendererKind,
  parseCoppermindCodeCellOutputs,
  parseJupyterAnsiText,
  serializeCoppermindCodeCellOutputs,
} from "../../packages/client/src/lib/jupyter-output";

describe("Jupyter output normalization", () => {
  it("merges adjacent stream output from the same stream", () => {
    const outputs = appendJupyterOutput(
      appendJupyterOutput([], {
        output_type: "stream",
        name: "stdout",
        text: "hello",
      }, "out:1"),
      {
        output_type: "stream",
        name: "stdout",
        text: "\nworld",
      },
      "out:2",
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      output_type: "stream",
      name: "stdout",
      text: "hello\nworld",
    });
  });

  it("renders common ANSI color codes without leaking escape text", () => {
    const raw = "\x1b[31mModuleNotFoundError\x1b[39m: No module named supabase";
    const segments = parseJupyterAnsiText(raw);
    const plain = getJupyterAnsiPlainText(raw);

    expect(plain).toBe("ModuleNotFoundError: No module named supabase");
    expect(plain.includes("[31m")).toBe(false);
    expect(
      segments.find((segment) => segment.text === "ModuleNotFoundError")?.style
        ?.foreground,
    ).toContain("ansiRed");
  });

  it("renders IPython traceback ANSI without leaking control text", () => {
    const raw = "\x1b[36mCell\x1b[39m \x1b[38;5;28;01mfrom\x1b[39;00m supabase";
    const segments = parseJupyterAnsiText(raw);
    const plain = getJupyterAnsiPlainText(raw);

    expect(plain).toBe("Cell from supabase");
    expect(plain.includes("[38;5;28;01m")).toBe(false);
    expect(segments.find((segment) => segment.text === "from")?.style)
      .toMatchObject({
        bold: true,
        foreground: "rgb(0, 135, 0)",
      });
  });

  it("collapses simple carriage-return progress output", () => {
    const raw =
      "Resolving dependencies...\r\x1b[2KInstalling packages...\r\x1b[2KInstalled supabase";

    expect(getJupyterAnsiPlainText(raw)).toBe("Installed supabase");
  });

  it("collapses cursor-up progress repaints", () => {
    const raw = [
      "Resolved 1 package in 144ms\n",
      "⠋ Preparing packages... (0/1)\n",
      "\x1b[1A\x1b[2K⠙ Preparing packages... (0/1)\n",
      "\x1b[1A\x1b[2KPrepared 1 package in 354ms\n",
      "Installed 1 package in 9ms\n",
      " + numpy==2.5.0",
    ].join("");

    expect(getJupyterAnsiPlainText(raw)).toBe([
      "Resolved 1 package in 144ms",
      "Prepared 1 package in 354ms",
      "Installed 1 package in 9ms",
      " + numpy==2.5.0",
    ].join("\n"));
  });

  it("renders merged progress stream chunks in place while preserving raw text", () => {
    const outputs = [
      {
        output_type: "stream" as const,
        name: "stdout",
        text: "⠋ Preparing packages... (0/1)\n",
      },
      {
        output_type: "stream" as const,
        name: "stdout",
        text: "\x1b[1A\x1b[2K⠙ Preparing packages... (0/1)\n",
      },
      {
        output_type: "stream" as const,
        name: "stdout",
        text: "\x1b[1A\x1b[2KPrepared 1 package in 354ms",
      },
    ].reduce(
      (current, output, index) =>
        appendJupyterOutput(current, output, `out:progress:${index}`),
      [] as CoppermindCodeCellOutput[],
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.output_type).toBe("stream");
    const text = outputs[0]?.output_type === "stream" ? outputs[0].text : "";
    expect(text).toContain("Preparing packages");
    expect(getJupyterAnsiPlainText(text)).toBe("Prepared 1 package in 354ms");
  });

  it("does not pad notebook output for terminal cursor movement", () => {
    const raw = "Using Python\x1b[24Cenvironment\n\x1b[10C1 package";

    expect(getJupyterAnsiPlainText(raw)).toBe(
      "Using Pythonenvironment\n1 package",
    );
  });

  it("keeps raw ANSI in persisted outputs while rendering derived text cleanly", () => {
    const raw = "\x1b[31mred\x1b[39m";
    const outputs = appendJupyterOutput([], {
      output_type: "stream",
      name: "stdout",
      text: raw,
    }, "out:ansi");
    const parsed = parseCoppermindCodeCellOutputs(
      serializeCoppermindCodeCellOutputs(outputs),
    );

    expect(parsed.outputs[0]).toMatchObject({
      output_type: "stream",
      text: raw,
    });
    expect(
      getJupyterAnsiPlainText(
        parsed.outputs[0]?.output_type === "stream"
          ? parsed.outputs[0].text
          : "",
      ),
    ).toBe("red");
  });

  it("normalizes common output renderers and persisted payloads", () => {
    const outputs = [
      appendJupyterOutput([], {
        output_type: "error",
        ename: "ValueError",
        evalue: "bad value",
        traceback: ["Traceback", "ValueError: bad value"],
      }, "out:error")[0],
      appendJupyterOutput([], {
        output_type: "execute_result",
        execution_count: 2,
        data: { "application/json": { ok: true } },
      }, "out:json")[0],
      appendJupyterOutput([], {
        output_type: "display_data",
        data: { "image/png": "iVBORw0KGgo=" },
      }, "out:image")[0],
      appendJupyterOutput([], {
        output_type: "display_data",
        data: { "text/html": "<strong>hello</strong>" },
      }, "out:html")[0],
      appendJupyterOutput([], {
        output_type: "display_data",
        data: { "text/plain": ["plain", " text"] },
      }, "out:text")[0],
    ];

    expect(outputs.map(getJupyterOutputRendererKind)).toEqual([
      "error",
      "json",
      "image",
      "html",
      "text",
    ]);

    const parsed = parseCoppermindCodeCellOutputs(
      serializeCoppermindCodeCellOutputs(outputs),
    );
    expect(parsed.version).toBe(1);
    expect(parsed.outputs.map((output) => output.outputId)).toEqual([
      "out:error",
      "out:json",
      "out:image",
      "out:html",
      "out:text",
    ]);
    expect(parsed.outputs.map(getJupyterOutputRendererKind)).toEqual([
      "error",
      "json",
      "image",
      "html",
      "text",
    ]);
  });

  it("recognizes standalone Markdown data-image outputs", () => {
    const output = appendJupyterOutput([], {
      output_type: "display_data",
      data: {
        "text/markdown":
          "![Sample Visualization](data:image/png;base64,iVBORw0KGgo=)",
      },
    }, "out:markdown-image")[0];
    if (!output || output.output_type !== "display_data") {
      throw new Error("expected display_data output");
    }

    expect(getJupyterOutputRendererKind(output)).toBe("markdown");
    expect(extractJupyterMarkdownImage(output.data["text/markdown"]))
      .toEqual({
        alt: "Sample Visualization",
        src: "data:image/png;base64,iVBORw0KGgo=",
      });

    const parsed = parseCoppermindCodeCellOutputs(
      serializeCoppermindCodeCellOutputs([output]),
    );
    const parsedOutput = parsed.outputs[0];
    if (!parsedOutput || parsedOutput.output_type !== "display_data") {
      throw new Error("expected parsed display_data output");
    }
    expect(
      extractJupyterMarkdownImage(parsedOutput.data["text/markdown"]),
    ).toEqual({
      alt: "Sample Visualization",
      src: "data:image/png;base64,iVBORw0KGgo=",
    });
  });

  it("leaves unsupported Markdown outputs in fallback mode", () => {
    expect(extractJupyterMarkdownImage("**bold** text")).toBeUndefined();
    expect(
      extractJupyterMarkdownImage(
        "![Remote image](https://example.com/plot.png)",
      ),
    ).toBeUndefined();
  });
});
