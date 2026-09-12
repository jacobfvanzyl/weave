import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaneFocusOwner, paneVisible } from './pane-focus';

let owner: PaneFocusOwner;
let disconnect: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 1));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
  owner = new PaneFocusOwner(); disconnect = owner.connect();
});
afterEach(() => { disconnect(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settle = async () => { await vi.advanceTimersByTimeAsync(10); };
const pane = (id: string) => {
  const element = document.createElement('textarea'); document.body.append(element);
  const focus = vi.fn(() => { element.focus(); return true; });
  const unregister = owner.register(id, { element, available: () => paneVisible(element), focus });
  return { element, focus, unregister };
};
it('restores a pane after ordinary chrome takes focus without forwarding key events', async () => {
  const terminal = pane('terminal'); owner.setFallbacks(['terminal']); await settle();
  expect(document.activeElement).toBe(terminal.element);
  const button = document.createElement('button'); document.body.append(button); button.focus();
  await settle(); expect(document.activeElement).toBe(terminal.element);
});
it('lets nested menus and dialogs own input and restores only after all overlays close', async () => {
  const terminal = pane('terminal'); owner.request('terminal'); await settle();
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu);
  const button = document.createElement('button'); menu.append(button); button.focus(); await settle();
  expect(document.activeElement).toBe(button);
  menu.remove(); await settle(); expect(terminal.focus).toHaveBeenCalledTimes(1);
  dialog.remove(); await settle(); expect(document.activeElement).toBe(terminal.element);
});
it('leaves explicit text fields alone until focus leaves them', async () => {
  const terminal = pane('terminal'); owner.request('terminal'); await settle();
  const search = document.createElement('input'); document.body.append(search); search.focus(); await settle();
  expect(document.activeElement).toBe(search);
  search.blur(); await settle(); expect(document.activeElement).toBe(terminal.element);
});
it('selects a visible replacement when the focused pane closes', async () => {
  const terminal = pane('terminal'), agent = pane('agent');
  owner.setFallbacks(['terminal', 'agent']); owner.request('agent'); await settle();
  agent.element.hidden = true; agent.element.blur(); await settle();
  expect(document.activeElement).toBe(terminal.element); expect(owner.snapshot()).toBe('terminal');
});
it('waits for native readiness and ignores an acknowledgement superseded by a composer request', async () => {
  const element = document.createElement('div'); document.body.append(element);
  let ready = false; let complete!: (focused: boolean) => void;
  const focus = vi.fn(() => new Promise<boolean>((resolve) => { complete = resolve; }));
  owner.register('terminal', { element, available: () => ready, focus });
  const agent = pane('agent'); owner.setFallbacks(['agent']); owner.request('terminal'); await settle();
  expect(focus).not.toHaveBeenCalled(); expect(agent.focus).not.toHaveBeenCalled();
  ready = true; owner.ready(); await settle(); expect(focus).toHaveBeenCalledOnce();
  owner.request('agent'); owner.didFocus('terminal'); complete(true); await settle();
  expect(owner.snapshot()).toBe('agent'); expect(document.activeElement).toBe(agent.element);
});
it('restores on app activation but does not take focus while the app is inactive', async () => {
  const terminal = pane('terminal'); owner.request('terminal'); await settle();
  window.dispatchEvent(new Event('blur')); terminal.element.blur(); await settle();
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('focus')); await settle();
  expect(document.activeElement).toBe(terminal.element); expect(terminal.focus).toHaveBeenCalledTimes(2);
});
it('waits until a pointer drag finishes before restoring pane focus', async () => {
  const terminal = pane('terminal'); owner.request('terminal'); await settle();
  const separator = document.createElement('div'); separator.setAttribute('role', 'separator'); separator.tabIndex = 0; document.body.append(separator);
  separator.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); separator.focus(); await settle();
  expect(document.activeElement).toBe(separator);
  separator.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await settle();
  expect(document.activeElement).toBe(terminal.element);
});
it('keeps a dismissed iPad keyboard closed across blur, layout and app activation until a pane is selected', async () => {
  disconnect(); owner = new PaneFocusOwner(true); disconnect = owner.connect();
  const terminal = pane('terminal'); owner.request('terminal'); await settle();
  terminal.element.blur(); await settle();
  owner.ready(); owner.restoreTarget();
  window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'));
  await settle();
  expect(owner.snapshot()).toBe('terminal');
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  owner.request('terminal'); await settle();
  expect(document.activeElement).toBe(terminal.element); expect(terminal.focus).toHaveBeenCalledTimes(2);
});
it('preserves iPad focus restoration when an ordinary control receives the blur', async () => {
  disconnect(); owner = new PaneFocusOwner(true); disconnect = owner.connect();
  const agent = pane('agent'); owner.request('agent'); await settle();
  const button = document.createElement('button'); document.body.append(button); button.focus();
  await settle(); expect(document.activeElement).toBe(agent.element);
});
it('pauses native iPad responder recovery even though the native surface has no DOM input', async () => {
  disconnect(); owner = new PaneFocusOwner(true); disconnect = owner.connect();
  const element = document.createElement('div'); document.body.append(element);
  const focus = vi.fn(() => true);
  owner.register('terminal', { element, available: () => true, focus });
  owner.request('terminal'); await settle();
  owner.didBlur('terminal'); await settle(); owner.ready(); await settle();
  expect(focus).toHaveBeenCalledTimes(1); expect(owner.snapshot()).toBe('terminal');
  owner.request('terminal'); await settle(); expect(focus).toHaveBeenCalledTimes(2);
});
it('does not treat keyboard hiding for a menu as an explicit dismissal', async () => {
  disconnect(); owner = new PaneFocusOwner(true); disconnect = owner.connect();
  const agent = pane('agent'); owner.request('agent'); await settle();
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu);
  agent.element.blur(); await settle();
  menu.remove(); await settle(); expect(document.activeElement).toBe(agent.element);
});
it('does not pause a native-to-composer handoff when UIKit hides the previous keyboard', async () => {
  disconnect(); owner = new PaneFocusOwner(true); disconnect = owner.connect();
  const previous = pane('previous'); owner.request('previous'); await settle();
  const element = document.createElement('textarea'); document.body.append(element);
  let complete!: (focused: boolean) => void;
  owner.register('agent', { element, available: () => paneVisible(element), focus: () => new Promise<boolean>((resolve) => { complete = resolve; }) });
  owner.request('agent'); await settle(); previous.element.blur();
  element.focus(); complete(true); await settle();
  const terminal = pane('terminal'); owner.setFallbacks(['terminal']);
  element.remove(); owner.didBlur('agent'); await settle();
  expect(document.activeElement).toBe(terminal.element);
});

it('phone navigation waits for deliberate input after browsing and overlay dismissal', async () => {
  disconnect(); owner = new PaneFocusOwner(true, true); disconnect = owner.connect();
  const terminal = pane('terminal'), agent = pane('agent');
  owner.setFallbacks(['terminal', 'agent']); owner.browse('terminal'); await settle();
  expect(terminal.focus).not.toHaveBeenCalled();
  owner.request('terminal'); await settle(); expect(terminal.focus).toHaveBeenCalledOnce();
  owner.browse('agent'); owner.ready(); await settle();
  expect(agent.focus).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); await settle();
  expect(agent.focus).not.toHaveBeenCalled();
  owner.request('agent'); await settle(); expect(agent.focus).toHaveBeenCalledOnce();
});
