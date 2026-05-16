import { truncateToWidth, visibleWidth, type Component } from 'pi-tui';
import { ansi, mocha } from '../theme.ts';

type FooterParts = {
  modelDisplayName: string;
  contextPercent?: number;
  title: {
    plane: string;
    demiplane?: string;
    thread?: string;
  };
};

const contextColor = (percent: number) => percent > 75 ? mocha.red : percent > 50 ? mocha.yellow : mocha.green;
const formatContextPercent = (percent: number) => percent > 0 && percent < 10 ? percent.toFixed(1) : percent.toFixed(0);

export class WeaveFooterComponent implements Component {
  constructor(private getParts: () => FooterParts) {}

  render(width: number) {
    const { modelDisplayName, contextPercent = 0, title } = this.getParts();
    const sep = ansi.fg(mocha.surface1, ' | ');
    const model = `${ansi.fg(mocha.green, '◆')} ${ansi.fg(mocha.green, modelDisplayName)}`;
    const context = ansi.fg(contextColor(contextPercent), `${formatContextPercent(contextPercent)}%`);
    const row1 = truncateToWidth(ansi.bold(`${model}${sep}${context}`), width);

    const titleParts = [
      ansi.fg(mocha.mauve, title.plane),
      title.demiplane ? ansi.fg(mocha.green, title.demiplane) : undefined,
      title.thread ? ansi.fg(mocha.text, ansi.bold(title.thread)) : undefined,
    ].filter((part): part is string => Boolean(part));
    const titleText = titleParts.join(ansi.fg(mocha.overlay0, ' / '));
    const titleWidth = visibleWidth(titleText);
    const leftPad = ' '.repeat(Math.max(0, Math.floor((width - titleWidth) / 2)));
    const row2 = truncateToWidth(`${leftPad}${titleText}`, width);

    return [truncateToWidth(row1, width), truncateToWidth(row2, width)];
  }

  invalidate() {}
}
