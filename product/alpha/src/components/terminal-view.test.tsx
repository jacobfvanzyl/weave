import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TerminalOutputStream } from '@/terminal/output-stream';
import { TerminalView } from './terminal-view';
const adapter = vi.hoisted(() => ({ available: true, render: vi.fn() }));
vi.mock('@/terminal/native-terminal', () => ({ get nativeTerminalAvailable() { return adapter.available; } }));
vi.mock('./native-terminal-view', () => ({ NativeTerminalView: (props: unknown) => { adapter.render(props); return <div>Native terminal</div>; } }));
beforeEach(() => { adapter.available = true; adapter.render.mockClear(); });
it('uses the native output adapter without an opt-in flag', () => {
  const output = new TerminalOutputStream(vi.fn()); const input = vi.fn();
  render(<TerminalView output={output} readOnly={false} focusRequest='pane' onInput={input} />);
  expect(adapter.render).toHaveBeenCalledWith(expect.objectContaining({ output, readOnly: false, focusRequest: 'pane', onInput: input }));
});
it('does not create a renderer in a browser preview', () => {
  adapter.available = false;
  render(<TerminalView output={new TerminalOutputStream(vi.fn())} readOnly={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('Native terminals require the Electron or iPad app.');
  expect(adapter.render).not.toHaveBeenCalled();
});
it('does not attach a native renderer without an output stream', () => {
  render(<TerminalView readOnly />);
  expect(screen.getByRole('status')).toHaveTextContent('Terminal is not attached.');
  expect(adapter.render).not.toHaveBeenCalled();
});
