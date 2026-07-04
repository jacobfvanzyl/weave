import {
  BlockComponent,
  BlockViewExtension,
  type ExtensionType,
  FlavourExtension,
} from "@blocksuite/block-std";
import { BlockModel, defineBlockSchema, Text } from "@blocksuite/store";
import { css, html, type PropertyValues } from "lit";
import { literal } from "lit/static-html.js";
import type { CoppermindJupyterEvent } from "./coppermind-jupyter";
import { createCodeMirrorSurface } from "./codemirror-surface";
import {
  appendJupyterOutput,
  type CoppermindCodeCellOutput,
  getJupyterOutputRendererKind,
  getMimeBundleText,
  getPreferredMimeType,
  type JupyterAnsiSegment,
  type JupyterAnsiStyle,
  parseCoppermindCodeCellOutputs,
  parseJupyterAnsiText,
  serializeCoppermindCodeCellOutputs,
} from "./jupyter-output";

export const coppermindCodeCellFlavour = "coppermind:code-cell";
export const coppermindCodeCellElementName = "coppermind-code-cell";
export const coppermindCodeCellSchemaVersion = 1;

export type CoppermindCodeCellLanguage = "python";
export type CoppermindCodeCellLastExecutionStatus =
  | "ok"
  | "error"
  | "interrupted"
  | null;

export type CoppermindCodeCellProps = {
  codeVersion: 1;
  executionCount: number | null;
  language: CoppermindCodeCellLanguage;
  lastExecutionStatus: CoppermindCodeCellLastExecutionStatus;
  outputsData: string;
  text: Text;
};

export type CoppermindCodeCellRunDetail = {
  advance: boolean;
  blockId: string;
};

type CoppermindCodeMirrorSurface = ReturnType<typeof createCodeMirrorSurface>;

type CoppermindCodeCellExecutionEvent = CustomEvent<CoppermindJupyterEvent>;

const sourcePathForLanguage = (language: string | undefined) => (
  language === "python" || !language ? "snippet.py" : `snippet.${language}`
);

export const createEmptyCoppermindCodeOutputsData = () => (
  serializeCoppermindCodeCellOutputs([])
);

export const normalizeCoppermindCodeCellLastExecutionStatus = (
  value: unknown,
): CoppermindCodeCellLastExecutionStatus => (
  value === "ok" || value === "error" || value === "interrupted" ? value : null
);

export const getCoppermindCodeCellSource = (
  model: { text?: { toString: () => string } } | undefined,
) => (
  model?.text?.toString() ?? ""
);

export const getCoppermindCodeCellOutputCount = (value: unknown) => (
  parseCoppermindCodeCellOutputs(value).outputs.length
);

const coppermindCodeCellStatusTones = new Set([
  "busy",
  "error",
  "idle",
  "interrupted",
  "ok",
  "queued",
  "running",
]);

const getCoppermindCodeCellStatusTone = (status: string | null | undefined) =>
  status && coppermindCodeCellStatusTones.has(status) ? status : "unknown";

export const CoppermindCodeCellSchema = defineBlockSchema({
  flavour: coppermindCodeCellFlavour,
  props: (internal): CoppermindCodeCellProps => ({
    codeVersion: 1,
    executionCount: null,
    language: "python",
    lastExecutionStatus: null,
    outputsData: createEmptyCoppermindCodeOutputsData(),
    text: internal.Text(),
  }),
  metadata: {
    version: coppermindCodeCellSchemaVersion,
    role: "content",
    parent: ["affine:note"],
    children: [],
  },
  toModel: () => new CoppermindCodeCellModel(),
});

export class CoppermindCodeCellModel
  extends BlockModel<CoppermindCodeCellProps> {
  declare flavour: typeof coppermindCodeCellFlavour;
}

const codeCellRunIcon = html`
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path
      d="M8 5.14v13.72c0 .75.82 1.21 1.46.82l10.92-6.86a.96.96 0 0 0 0-1.64L9.46 4.32A.96.96 0 0 0 8 5.14Z"
    >
    </path>
  </svg>
`;

const normalizeTextData = (value: unknown) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join("");
  return value === undefined || value === null ? "" : String(value);
};

const dataUriForImage = (mimeType: string, value: unknown) => {
  const text = normalizeTextData(value);
  if (mimeType === "image/svg+xml" && text.trimStart().startsWith("<")) {
    return `data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`;
  }
  return `data:${mimeType};base64,${text}`;
};

const jsonDisplay = (value: unknown) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const ansiSegmentStyle = (style: JupyterAnsiStyle | undefined) => {
  if (!style) return {};
  const foreground = style.inverse
    ? style.background ?? "var(--affine-background-primary-color, #fff)"
    : style.foreground;
  const background = style.inverse
    ? style.foreground ?? "var(--affine-text-primary-color, #111827)"
    : style.background;
  return {
    ...(foreground ? { color: foreground } : {}),
    ...(background ? { backgroundColor: background } : {}),
    ...(style.bold ? { fontWeight: "700" } : {}),
    ...(style.faint ? { opacity: "0.72" } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(style.underline ? { textDecoration: "underline" } : {}),
  };
};

export class CoppermindCodeCellComponent
  extends BlockComponent<CoppermindCodeCellModel> {
  static override styles = css`
    :host {
      box-sizing: border-box;
      display: block;
      min-height: 0;
      width: 100%;
    }

    coppermind-code-cell {
      display: block;
      outline: none;
      -webkit-tap-highlight-color: transparent;
    }

    .coppermind-code-cell-frame {
      border: 1px solid
        color-mix(in srgb, var(--affine-border-color, #d1d5db) 78%, transparent);
      border-radius: 7px;
      background: var(
        --weave-editor-background,
        var(--affine-background-primary-color, #fff)
      );
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      width: 100%;
    }

    .coppermind-code-cell-toolbar {
      align-items: center;
      border-bottom: 1px solid
        color-mix(in srgb, var(--affine-border-color, #d1d5db) 70%, transparent);
      display: flex;
      gap: 8px;
      min-height: 32px;
      padding: 4px 8px;
    }

    .coppermind-code-cell-language,
    .coppermind-code-cell-count {
      color: var(--affine-text-secondary-color, #64748b);
      font: 11px/1.2 var(--font-sans, system-ui, sans-serif);
      white-space: nowrap;
    }

    .coppermind-code-cell-language {
      font-weight: 600;
      text-transform: uppercase;
    }

    .coppermind-code-cell-spacer {
      flex: 1;
      min-width: 12px;
    }

    .coppermind-code-cell-status-badge {
      --coppermind-code-cell-status-color: var(
        --muted-foreground,
        var(--affine-text-secondary-color, #64748b)
      );
      align-items: center;
      background: color-mix(
        in srgb,
        var(--coppermind-code-cell-status-color) 13%,
        transparent
      );
      border: 1px solid
        color-mix(
          in srgb,
          var(--coppermind-code-cell-status-color) 34%,
          transparent
        );
      border-radius: 999px;
      box-sizing: border-box;
      display: inline-flex;
      height: 18px;
      justify-content: center;
      min-width: 18px;
      padding: 0 5px;
    }

    .coppermind-code-cell-status-badge[data-status="ok"] {
      --coppermind-code-cell-status-color: var(--success, #22c55e);
    }

    .coppermind-code-cell-status-badge[data-status="error"] {
      --coppermind-code-cell-status-color: var(--destructive, #ef4444);
    }

    .coppermind-code-cell-status-badge[data-status="interrupted"],
    .coppermind-code-cell-status-badge[data-status="queued"] {
      --coppermind-code-cell-status-color: var(--warning, #f59e0b);
    }

    .coppermind-code-cell-status-badge[data-status="busy"],
    .coppermind-code-cell-status-badge[data-status="running"] {
      --coppermind-code-cell-status-color: var(--info, var(--primary, #3b82f6));
    }

    .coppermind-code-cell-status-badge[data-status="idle"] {
      --coppermind-code-cell-status-color: var(
        --muted-foreground,
        var(--affine-text-secondary-color, #64748b)
      );
    }

    .coppermind-code-cell-status-dot {
      background: var(--coppermind-code-cell-status-color);
      border-radius: 999px;
      box-shadow: 0 0 0 2px
        color-mix(
          in srgb,
          var(--coppermind-code-cell-status-color) 20%,
          transparent
        );
      display: block;
      height: 7px;
      width: 7px;
    }

    .coppermind-code-cell-run {
      align-items: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--affine-primary-color, #6d28d9);
      cursor: pointer;
      display: inline-flex;
      height: 24px;
      justify-content: center;
      padding: 0;
      width: 24px;
    }

    .coppermind-code-cell-run:hover,
    .coppermind-code-cell-run:focus-visible {
      background: color-mix(
        in srgb,
        var(--affine-primary-color, #6d28d9) 12%,
        transparent
      );
      border-color: color-mix(
        in srgb,
        var(--affine-primary-color, #6d28d9) 24%,
        transparent
      );
      outline: none;
    }

    .coppermind-code-cell-run svg {
      display: block;
      height: 14px;
      width: 14px;
    }

    .coppermind-code-cell-editor {
      background: var(
        --weave-editor-background,
        var(--affine-background-primary-color, #fff)
      );
      color: var(
        --weave-editor-foreground,
        var(--affine-text-primary-color, #111827)
      );
      display: flex;
      flex: 0 0 auto;
      min-height: 0;
      overflow: hidden;
      padding: 0;
    }

    .coppermind-code-cell-frame[data-has-output="false"]
      .coppermind-code-cell-editor {
      flex: 0 0 auto;
    }

    .coppermind-code-cell-editor > .cm-editor {
      flex: 1 1 auto;
      min-height: inherit;
      width: 100%;
    }

    .coppermind-code-cell-editor > .cm-editor {
      height: auto;
    }

    .coppermind-code-cell-editor .cm-content {
      min-height: 0;
    }

    .coppermind-code-cell-editor .cm-scroller {
      overflow: auto;
    }

    .coppermind-code-cell-output {
      border-top: 1px solid
        color-mix(in srgb, var(--affine-border-color, #d1d5db) 70%, transparent);
      background: color-mix(
        in srgb,
        var(--affine-background-primary-color, #fff) 96%,
        var(--affine-hover-color, #f3f4f6)
      );
      color: var(--affine-text-primary-color, #111827);
      flex: 1 1 auto;
      min-height: 0;
    }

    .coppermind-code-cell-output-item {
      border-top: 1px solid
        color-mix(in srgb, var(--affine-border-color, #d1d5db) 42%, transparent);
      font: 12px/1.5
        var(
          --font-code,
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          monospace
        );
      overflow: auto;
      padding: 12px 16px;
    }

    .coppermind-code-cell-output-item:first-child {
      border-top: 0;
    }

    .coppermind-code-cell-output-item pre {
      margin: 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .coppermind-code-cell-output-item[data-output-kind="error"] {
      --coppermind-code-cell-error-accent: var(
        --vscode-terminal-ansiRed,
        var(--ctp-red, #dc2626)
      );
      background: color-mix(
        in srgb,
        var(--affine-background-primary-color, #fff) 94%,
        var(--coppermind-code-cell-error-accent) 6%
      );
      box-shadow: inset 3px 0
        color-mix(
          in srgb,
          var(--coppermind-code-cell-error-accent) 72%,
          transparent
        );
      color: var(--affine-text-primary-color, #111827);
    }

    .coppermind-code-cell-output-item[data-output-stream="stderr"] {
      color: #b45309;
    }

    .coppermind-code-cell-output-item img {
      display: block;
      max-width: 100%;
    }

    .coppermind-code-cell-html-frame {
      border: 0;
      display: block;
      min-height: 140px;
      width: 100%;
    }
  `;

  private _surface: CoppermindCodeMirrorSurface | undefined;

  private _isSyncingEditor = false;

  private _liveOutputs: CoppermindCodeCellOutput[] | undefined;

  private _liveExecutionCount: number | null | undefined;

  private _liveStatus: string | undefined;

  private _clearBeforeNextOutput = false;

  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = "false";
    if (!this.hasAttribute("tabindex")) this.tabIndex = -1;
    this.setAttribute("data-coppermind-code-cell-block-id", this.model.id);
    this.addEventListener(
      "coppermind-code-cell-execution-event",
      this._handleExecutionEvent as EventListener,
    );
  }

  override disconnectedCallback() {
    this.removeEventListener(
      "coppermind-code-cell-execution-event",
      this._handleExecutionEvent as EventListener,
    );
    this._surface?.destroy();
    this._surface = undefined;
    super.disconnectedCallback();
  }

  override firstUpdated() {
    const editor = this.renderRoot.querySelector<HTMLElement>(
      ".coppermind-code-cell-editor",
    );
    if (!editor) return;

    const runInPlace = () => {
      this._run(false);
      return true;
    };
    const runAndAdvance = () => {
      this._run(true);
      return true;
    };

    this._surface = createCodeMirrorSurface({
      parent: editor,
      value: this._source,
      path: sourcePathForLanguage(this.model.language),
      theme: "editor",
      basicSetup: true,
      lineWrapping: true,
      relativeLineNumbers: true,
      vim: true,
      attributes: {
        "data-coppermind-code-cell-editor": "true",
      },
      contentAttributes: {
        "aria-label": "Code cell source",
      },
      keyBindings: [
        {
          key: "Shift-Enter",
          run: runAndAdvance,
        },
        {
          key: "Mod-Enter",
          run: runInPlace,
        },
        {
          key: "Cmd-Enter",
          run: runInPlace,
        },
      ],
      onChange: (value) => {
        if (this._isSyncingEditor) return;
        this.doc.updateBlock(this.model, {
          codeVersion: 1,
          text: new Text(value),
        });
      },
      onVimModeChange: (mode) => {
        this.setAttribute("data-coppermind-code-cell-vim-mode", mode);
      },
    });
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    this.setAttribute("data-coppermind-code-cell-block-id", this.model.id);
    this._syncEditorSource();
  }

  private get _source() {
    return getCoppermindCodeCellSource(this.model);
  }

  private _syncEditorSource() {
    const source = this._source;
    if (!this._surface || this._surface.getValue() === source) return;
    this._isSyncingEditor = true;
    try {
      this._surface.setValue(source);
    } finally {
      this._isSyncingEditor = false;
    }
  }

  private _run(advance: boolean) {
    this.dispatchEvent(
      new CustomEvent<CoppermindCodeCellRunDetail>("coppermind-code-cell-run", {
        bubbles: true,
        composed: true,
        detail: {
          advance,
          blockId: this.model.id,
        },
      }),
    );
  }

  private _handleToolbarRun = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    this._run(false);
  };

  private _handleCellPointerDown = () => {
    this.dispatchEvent(
      new CustomEvent("coppermind-code-cell-focus", {
        bubbles: true,
        composed: true,
        detail: { blockId: this.model.id },
      }),
    );
  };

  private _handleExecutionEvent = (event: CoppermindCodeCellExecutionEvent) => {
    const jupyterEvent = event.detail;
    if (!jupyterEvent) return;

    if (jupyterEvent.type === "status") {
      this._liveStatus = jupyterEvent.executionState;
    } else if (jupyterEvent.type === "execution_input") {
      this._liveExecutionCount = jupyterEvent.executionCount;
      this._liveStatus = "busy";
      this._liveOutputs = [];
    } else if (jupyterEvent.type === "clear_output") {
      if (jupyterEvent.wait) {
        this._clearBeforeNextOutput = true;
      } else {
        this._liveOutputs = [];
        this._clearBeforeNextOutput = false;
      }
    } else if (jupyterEvent.type === "output") {
      const current = this._clearBeforeNextOutput ? [] : this._currentOutputs;
      this._liveOutputs = appendJupyterOutput(current, jupyterEvent.output);
      this._clearBeforeNextOutput = false;
    } else if (jupyterEvent.type === "complete") {
      this._liveStatus = jupyterEvent.status;
      this._liveExecutionCount = jupyterEvent.executionCount ??
        this._liveExecutionCount ?? null;
      this._clearBeforeNextOutput = false;
    } else if (jupyterEvent.type === "error") {
      this._liveStatus = "error";
      this._liveOutputs = appendJupyterOutput(this._currentOutputs, {
        output_type: "error",
        ename: "JupyterError",
        evalue: jupyterEvent.error,
        traceback: [],
      });
      this._clearBeforeNextOutput = false;
    }

    this.requestUpdate();
  };

  private get _persistedOutputs() {
    return parseCoppermindCodeCellOutputs(this.model.outputsData).outputs;
  }

  private get _currentOutputs() {
    return this._liveOutputs ?? this._persistedOutputs;
  }

  private _renderAnsiSegment(segment: JupyterAnsiSegment) {
    if (!segment.style) return segment.text;
    if (typeof document === "undefined") return segment.text;
    const span = document.createElement("span");
    Object.assign(span.style, ansiSegmentStyle(segment.style));
    span.textContent = segment.text;
    return span;
  }

  private _renderAnsiPre(value: unknown) {
    return html`
      <pre>${parseJupyterAnsiText(value).map((segment) =>
        this._renderAnsiSegment(segment)
      )}</pre>
    `;
  }

  private _renderOutput(output: CoppermindCodeCellOutput) {
    const kind = getJupyterOutputRendererKind(output);
    if (output.output_type === "stream") {
      return html`
        <div
          class="coppermind-code-cell-output-item"
          data-output-kind="${kind}"
          data-output-stream="${output.name}"
        >
          ${this._renderAnsiPre(output.text)}
        </div>
      `;
    }
    if (output.output_type === "error") {
      const traceback = output.traceback.length
        ? output.traceback.join("\n")
        : [output.ename, output.evalue].filter(Boolean).join(": ");
      return html`
        <div class="coppermind-code-cell-output-item" data-output-kind="error">
          ${this._renderAnsiPre(traceback)}
        </div>
      `;
    }

    const mimeType = getPreferredMimeType(output.data);
    if (kind === "image" && mimeType) {
      return html`
        <div class="coppermind-code-cell-output-item" data-output-kind="${kind}">
          <img alt="Jupyter output" src="${dataUriForImage(
            mimeType,
            output.data[mimeType],
          )}" />
        </div>
      `;
    }
    if (kind === "json" && mimeType) {
      return html`
        <div class="coppermind-code-cell-output-item" data-output-kind="${kind}">
          <pre>${jsonDisplay(output.data[mimeType])}</pre>
        </div>
      `;
    }
    if (kind === "html" && mimeType) {
      return html`
        <div class="coppermind-code-cell-output-item" data-output-kind="${kind}">
          <iframe
            class="coppermind-code-cell-html-frame"
            sandbox=""
            srcdoc="${normalizeTextData(output.data[mimeType])}"
            title="Jupyter HTML output"
          ></iframe>
        </div>
      `;
    }
    if (kind === "markdown" && mimeType) {
      return html`
        <div class="coppermind-code-cell-output-item" data-output-kind="${kind}">
          <pre>${normalizeTextData(output.data[mimeType])}</pre>
        </div>
      `;
    }
    if (kind === "text" && mimeType) {
      return html`
        <div class="coppermind-code-cell-output-item" data-output-kind="${kind}">
          ${this._renderAnsiPre(output.data[mimeType])}
        </div>
      `;
    }

    return html`
      <div class="coppermind-code-cell-output-item" data-output-kind="unknown">
        ${this._renderAnsiPre(getMimeBundleText(output.data) ?? "")}
      </div>
    `;
  }

  private _renderOutputs() {
    const outputs = this._currentOutputs;
    if (!outputs.length) return null;
    return html`
      <div class="coppermind-code-cell-output">
        ${outputs.map((output) => this._renderOutput(output))}
      </div>
    `;
  }

  override render() {
    const executionCount = this._liveExecutionCount ??
      this.model.executionCount;
    const status = this._liveStatus ??
      normalizeCoppermindCodeCellLastExecutionStatus(
        this.model.lastExecutionStatus,
      );
    const executionLabel =
      executionCount === null || executionCount === undefined
        ? "[ ]"
        : `[${executionCount}]`;
    const hasOutputs = this._currentOutputs.length > 0;
    const statusTone = getCoppermindCodeCellStatusTone(status);
    return html`
      <div
        class="coppermind-code-cell-frame"
        data-has-output="${hasOutputs ? "true" : "false"}"
        @pointerdown="${this._handleCellPointerDown}"
      >
        <div class="coppermind-code-cell-toolbar">
          <button
            class="coppermind-code-cell-run"
            type="button"
            title="Run cell"
            aria-label="Run cell"
            @click="${this._handleToolbarRun}"
          >
            ${codeCellRunIcon}
          </button>
          <span class="coppermind-code-cell-count">${executionLabel}</span>
          <span class="coppermind-code-cell-language">${this.model
            .language}</span>
          <span class="coppermind-code-cell-spacer"></span>
          ${status
            ? html`
              <span
                class="coppermind-code-cell-status-badge"
                data-status="${statusTone}"
                title="${status}"
                aria-label="Cell status: ${status}"
              >
                <span class="coppermind-code-cell-status-dot"></span>
              </span>
            `
            : null}
        </div>
        <div class="coppermind-code-cell-editor"></div>
        ${this._renderOutputs()}
      </div>
    `;
  }
}

export const CoppermindCodeCellBlockSpec: ExtensionType[] = [
  FlavourExtension(coppermindCodeCellFlavour),
  BlockViewExtension(coppermindCodeCellFlavour, literal`coppermind-code-cell`),
];

let coppermindCodeCellElementsRegistered = false;

export const registerCoppermindCodeCellElements = () => {
  if (
    typeof customElements === "undefined" ||
    coppermindCodeCellElementsRegistered
  ) return;
  if (!customElements.get(coppermindCodeCellElementName)) {
    customElements.define(
      coppermindCodeCellElementName,
      CoppermindCodeCellComponent,
    );
  }
  coppermindCodeCellElementsRegistered = true;
};

declare global {
  namespace BlockSuite {
    interface BlockModels {
      [coppermindCodeCellFlavour]: CoppermindCodeCellModel;
    }
  }

  interface HTMLElementTagNameMap {
    [coppermindCodeCellElementName]: CoppermindCodeCellComponent;
  }
}
