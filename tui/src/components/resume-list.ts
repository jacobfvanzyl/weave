import { SelectList, type Component, type SelectItem } from 'pi-tui';
import { ansi, mocha } from '../theme.ts';
import type { ChatThread } from '../types.ts';

const threadTitle = (thread: ChatThread) =>
  thread.title && !['...', 'New chat'].includes(thread.title) ? thread.title : 'Untitled';

const threadDescription = (thread: ChatThread) => {
  const updated = thread.updatedAt ? thread.updatedAt.slice(0, 19).replace('T', ' ') : undefined;
  return [updated, thread.id].filter(Boolean).join('  ');
};

export class ResumeList implements Component {
  private list: SelectList;

  constructor(threads: ChatThread[], onSelect: (thread: ChatThread) => void, onCancel: () => void) {
    const items: SelectItem[] = threads.map(thread => ({
      value: thread.id,
      label: threadTitle(thread),
      description: threadDescription(thread),
    }));

    this.list = new SelectList(items, 12, {
      selectedPrefix: (text: string) => ansi.fg(mocha.mauve, text),
      selectedText: (text: string) => ansi.fg(mocha.mauve, ansi.bold(text)),
      description: (text: string) => ansi.fg(mocha.overlay0, text),
      scrollInfo: (text: string) => ansi.fg(mocha.overlay0, text),
      noMatch: (text: string) => ansi.fg(mocha.overlay0, text),
    }, {
      minPrimaryColumnWidth: 32,
      maxPrimaryColumnWidth: 48,
    });

    this.list.onSelect = item => {
      const selected = threads.find(thread => thread.id === item.value);
      if (selected) onSelect(selected);
    };
    this.list.onCancel = onCancel;
  }

  render(width: number) {
    return [
      ansi.fg(mocha.mauve, ansi.bold('Resume Thread')),
      ansi.fg(mocha.overlay0, 'Choose a thread from this demiplane'),
      '',
      ...this.list.render(width),
    ];
  }

  handleInput(data: string) {
    this.list.handleInput(data);
  }

  invalidate() {
    this.list.invalidate();
  }
}
