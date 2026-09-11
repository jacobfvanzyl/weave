import { act, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDesktopTitlebar } from './use-desktop-titlebar';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (navigator as any).windowControlsOverlay; });

it('moves the native-control reservation between top rails and clears it in fullscreen', async () => {
  const setTopRailHeight = vi.fn(async () => 19.2);
  vi.stubGlobal('weaveDesktop', { setTopRailHeight });
  const overlay = Object.assign(new EventTarget(), { visible: true, getTitlebarAreaRect: () => new DOMRect(80, 0, 900, 32) });
  Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
  let sidebarOpen = true;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'sidebar') return sidebarOpen ? new DOMRect(0, 0, 250, 32) : new DOMRect();
    if (this.dataset.testid === 'terminal') return new DOMRect(sidebarOpen ? 250 : 0, 0, 500, 32);
    return new DOMRect(0, 300, 500, 32);
  });
  function Harness() { useDesktopTitlebar(); return <><header data-testid='sidebar' data-slot='sidebar-header' /><header data-testid='terminal' data-slot='terminal-top-rail' /><header data-testid='lower' data-slot='terminal-top-rail' /></>; }
  const view = render(<Harness />);
  await waitFor(() => expect(setTopRailHeight).toHaveBeenCalledWith(32, 32));
  expect(document.documentElement.style.getPropertyValue('--alpha-window-corner-radius')).toBe('19.2px');
  expect(view.getByTestId('sidebar')).toHaveAttribute('data-window-controls-leading');
  expect(view.getByTestId('terminal')).toHaveAttribute('data-window-top-rail');
  expect(view.getByTestId('terminal')).not.toHaveAttribute('data-window-controls-leading');
  expect(view.getByTestId('lower')).not.toHaveAttribute('data-window-top-rail');
  act(() => { sidebarOpen = false; window.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(view.getByTestId('terminal')).toHaveAttribute('data-window-controls-leading'));
  expect(view.getByTestId('sidebar')).not.toHaveAttribute('data-window-top-rail');
  act(() => { overlay.visible = false; overlay.getTitlebarAreaRect = () => new DOMRect(); overlay.dispatchEvent(new Event('geometrychange')); });
  await waitFor(() => expect(view.getByTestId('terminal')).not.toHaveAttribute('data-window-controls-leading'));
  expect(setTopRailHeight).toHaveBeenLastCalledWith(32, 0);
  act(() => { overlay.visible = true; overlay.getTitlebarAreaRect = () => new DOMRect(90, 0, 700, 33); overlay.dispatchEvent(new Event('geometrychange')); });
  await waitFor(() => expect(setTopRailHeight).toHaveBeenLastCalledWith(32, 33));
  expect(view.getByTestId('terminal')).toHaveAttribute('data-window-controls-leading');
  view.unmount();
  expect(document.documentElement.style.getPropertyValue('--alpha-window-corner-radius')).toBe('');
});

it('reserves the sidebar toggle on the leading rail without native traffic lights, including safe-area offsets', async () => {
  let sidebarOpen = true;
  vi.stubGlobal('weaveDesktop', undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'sidebar') return sidebarOpen ? new DOMRect(0, 24, 250, 32) : new DOMRect();
    return new DOMRect(sidebarOpen ? 250 : 0, 24, 500, 32);
  });
  function Harness() { useDesktopTitlebar(true); return <><header data-testid='sidebar' data-slot='sidebar-header' /><header data-testid='terminal' data-slot='terminal-top-rail' /></>; }
  const view = render(<Harness />);
  await waitFor(() => expect(view.getByTestId('sidebar')).toHaveAttribute('data-shell-controls-leading'));
  expect(document.documentElement.style.getPropertyValue('--alpha-window-controls-width')).toBe('0px');
  act(() => { sidebarOpen = false; window.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(view.getByTestId('terminal')).toHaveAttribute('data-shell-controls-leading'));
  expect(view.getByTestId('sidebar')).not.toHaveAttribute('data-shell-controls-leading');
});

it('rounds only the visible pane at both outside bottom and right edges as the layout changes', async () => {
  let agentRight = true;
  vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.slot === 'terminal-top-rail') return new DOMRect(0, 0, 1000, 32);
    if (this.dataset.testid === 'upper') return new DOMRect(0, 32, 1000, 300);
    const right = this.dataset.testid === (agentRight ? 'agent' : 'terminal');
    return new DOMRect(right ? 500 : 0, 332, 500, 468);
  });
  function Harness() { useDesktopTitlebar(); return <><header data-slot='terminal-top-rail' /><div data-testid='upper' data-slot='terminal-focus-border' /><div data-testid='terminal' data-slot='terminal-focus-border' /><div data-testid='agent' data-slot='thread-pane' /></>; }
  const view = render(<Harness />);
  await waitFor(() => expect(view.getByTestId('agent')).toHaveAttribute('data-window-bottom-right'));
  expect(view.getByTestId('upper')).not.toHaveAttribute('data-window-bottom-right');
  expect(view.getByTestId('terminal')).not.toHaveAttribute('data-window-bottom-right');
  act(() => { agentRight = false; window.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(view.getByTestId('terminal')).toHaveAttribute('data-window-bottom-right'));
  expect(view.getByTestId('agent')).not.toHaveAttribute('data-window-bottom-right');
  act(() => { view.getByTestId('terminal').hidden = true; });
  await waitFor(() => expect(view.getByTestId('terminal')).not.toHaveAttribute('data-window-bottom-right'));
});
