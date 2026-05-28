import { CombinedAutocompleteProvider, Editor, getKeybindings, truncateToWidth, TUI, type Component, type Focusable } from 'pi-tui';
import { renderTranscriptMessage } from '../messages.ts';
import { ansi, mocha } from '../theme.ts';
import type { AppState } from '../types.ts';
import { WeaveFooterComponent } from './footer.ts';

export class WeaveApp implements Component, Focusable {
  focused = true;
  private editor: Editor;
  private footer: WeaveFooterComponent;
  onSubmit?: (text: string) => void;
  onCancel?: () => void;

  constructor(private tui: TUI, private state: AppState) {
    this.footer = new WeaveFooterComponent(() => ({
      modelDisplayName: this.state.modelDisplayName,
      connectionStatus: this.state.connectionStatus,
      contextPercent: this.state.contextPercent,
      title: this.state.title,
    }));
    this.editor = new Editor(tui, {
      borderColor: (text: string) => ansi.fg(mocha.blue, text),
      selectList: {
        selectedPrefix: (text: string) => ansi.fg(mocha.mauve, text),
        selectedText: (text: string) => ansi.fg(mocha.mauve, text),
        description: (text: string) => ansi.fg(mocha.overlay0, text),
        scrollInfo: (text: string) => ansi.fg(mocha.overlay0, text),
        noMatch: (text: string) => ansi.fg(mocha.overlay0, text),
      },
    }, { paddingX: 0 });
    this.editor.onSubmit = text => this.onSubmit?.(text);
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
      { name: 'new', description: 'Start a new draft thread' },
      { name: 'archive', description: 'Archive current thread and start a draft' },
      { name: 'threads', description: 'Resume a thread in this demiplane' },
    ], Deno.cwd()));
  }

  render(width: number) {
    this.editor.focused = this.focused;
    const lines: string[] = [];
    for (let index = 0; index < this.state.messages.length; index += 1) {
      const message = this.state.messages[index];
      lines.push('', ...renderTranscriptMessage(message, width));
    }
    if (this.state.status) lines.push('', ansi.fg(mocha.overlay0, this.state.status));
    lines.push('', ...this.editor.render(width), ...this.footer.render(width));
    return lines.map(line => truncateToWidth(line, width));
  }

  handleInput(data: string) {
    if (getKeybindings().matches(data, 'tui.input.copy')) {
      this.onCancel?.();
      return;
    }
    this.editor.handleInput(data);
  }

  invalidate() {
    this.editor.invalidate();
    this.footer.invalidate();
  }

  clearEditor() {
    this.editor.setText('');
  }

  addToHistory(text: string) {
    this.editor.addToHistory(text);
  }
}
