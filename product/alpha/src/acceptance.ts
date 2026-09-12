import { nativeTerminalAcceptance } from '@/terminal/native-terminal';
// Included only in explicitly built acceptance artifacts.
export type LiveAcceptanceInput = { hostUrl: string; pairingToken?: string; workspaceName: string; directory?: string; permission?: boolean };
export async function runLiveShellAcceptance(input: LiveAcceptanceInput) {
  let stage = 'pairing';
  let outsideBottomRightRadius = 0;
  const state = window as unknown as { alphaAcceptanceStage?: string; alphaAcceptanceDetail?: string; alphaAcceptanceNativeSmoke?: boolean; alphaAcceptanceKeyboardDismissal?: boolean };
  const wait = async (predicate: () => unknown) => {
    state.alphaAcceptanceDetail = stage;
    for (let n = 0; n < 600; n++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out at ${stage}`);
  };
  const windowCornersMatch = () => {
    const radius = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--alpha-window-corner-radius')) || 0;
    outsideBottomRightRadius = Math.max(outsideBottomRightRadius, radius);
    return [...document.querySelectorAll<HTMLElement>('[data-slot="terminal-focus-border"], [data-slot="thread-pane"]')].filter(el => el.getBoundingClientRect().height > 0).every(el => {
      const rect = el.getBoundingClientRect();
      const outside = Math.abs(rect.right - innerWidth) < 1.5 && Math.abs(rect.bottom - innerHeight) < 1.5;
      const style = getComputedStyle(el);
      const expected = outside ? radius : 0;
      return parseFloat(style.borderBottomRightRadius) === expected && parseFloat(style.borderBottomLeftRadius) === 0 && (el.dataset.slot !== 'thread-pane' || parseFloat(getComputedStyle(el, '::before').borderBottomRightRadius) === expected);
    });
  };
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role=menuitem]')].find((el) => el.getBoundingClientRect().height > 0 && (el.getAttribute('aria-label') === name || el.textContent?.trim() === name));
  const set = (selector: string, value: string) => {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  try {
    if (input.pairingToken) {
      await wait(() => button('Connections') || button('Settings') || document.querySelector('#pairing-token'));
      (button('Connections') ?? button('Settings'))?.click();
      await wait(() => document.querySelector('#pairing-token'));
      set('#host-url', input.hostUrl);
      set('#pairing-token', input.pairingToken);
      await wait(() => button('Pair and Connect') && !button('Pair and Connect')!.disabled);
      button('Pair and Connect')!.click();
      // An already-known Host can expose its workspace while a failed pairing
      // dialog still blocks native input. Require successful dialog dismissal.
      await wait(() => !document.querySelector('#pairing-token'));
    }
    const openWorkspace = async () => {
      await wait(() => button('Sidebar actions')); button('Sidebar actions')!.click();
      await wait(() => button('New workspace…')); button('New workspace…')!.click();
      const directory = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"] [title]')].find(el => el.getBoundingClientRect().height > 0 && (input.directory ? el.getAttribute('title') === input.directory : el.getAttribute('title')?.endsWith('/workspace')))?.closest<HTMLElement>('[role="menuitem"]');
      await wait(directory);
      const before = new Set([...document.querySelectorAll('[data-workspace-id]')].map(el => el.getAttribute('data-workspace-id')));
      directory()!.click();
      let created: Element | undefined;
      await wait(() => { created = [...document.querySelectorAll('[data-workspace-id]')].find(el => !before.has(el.getAttribute('data-workspace-id')) && el.querySelector('[aria-label^="Workspace "][aria-pressed="true"]')); return created; });
      return created!.getAttribute('data-workspace-id')!;
    };
    stage = 'create workspace';
    const originalWorkspace = await openWorkspace();
    const newThread = async () => {
      const previousThread = document.querySelector('[data-thread-id]:has([aria-pressed="true"])')?.getAttribute('data-thread-id');
      document.querySelector<HTMLButtonElement>(`[data-workspace-id="${CSS.escape(originalWorkspace)}"] [aria-label="Workspace actions for ${CSS.escape(input.workspaceName)}"]`)!.click();
      await wait(() => button('New agent thread')); button('New agent thread')!.click();
      await wait(() => document.querySelector('[aria-label="Message agent"]') || document.querySelector('[role="dialog"]'));
      const choice = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button [title]')].find(el => input.directory ? el.getAttribute('title') === input.directory : el.getAttribute('title')?.endsWith('/workspace'))?.closest<HTMLButtonElement>('button');
      choice?.click();
      // A reconnected shell already has a composer. Wait for the newly created
      // draft before sending a prompt or inspecting its workspace's terminal.
      await wait(() => {
        const selected = document.querySelector('[data-thread-id]:has([aria-pressed="true"])')?.getAttribute('data-thread-id');
        return selected && selected !== previousThread && document.querySelector('[aria-label="Message agent"]') && document.body.textContent?.includes('Start a conversation with the agent.');
      });
    };
    stage = 'create thread';
    await newThread();
    await wait(() => document.querySelector('[aria-label="Message agent"]') && document.body.textContent?.includes('Start a conversation with the agent.'));
    stage = 'discard draft pane';
    const discardedDraft = document.querySelector('[data-thread-id]:has([aria-pressed="true"])')!.getAttribute('data-thread-id')!;
    button('Close agent pane')!.click();
    await wait(() => !document.querySelector(`[data-thread-id="${CSS.escape(discardedDraft)}"]`) && !document.querySelector('[data-slot="thread-pane"]'));
    await newThread();
    stage = 'ACP prompt';
    const prompt = input.permission ? 'UI_PERMISSION' : 'Reply with exactly WEAVE_DESKTOP_REAL_PROVIDER_OK. Do not use any tools.';
    // A new ACP draft can replace the provisional composer during preflight.
    // Resolve the mounted input again until its controlled value is ready.
    await wait(() => {
      const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]');
      if (!composer) return false;
      if (composer.value !== prompt || button('Send message')?.disabled) {
        set('[aria-label="Message agent"]', prompt);
        return false;
      }
      return Boolean(button('Send message'));
    });
    button('Send message')!.click();
    if (input.permission) {
      stage = 'ACP permission';
      await wait(() => button('Allow once'));
      const pendingThread = document.querySelector('[data-thread-id]:has([aria-pressed="true"])')?.getAttribute('data-thread-id');
      if (!pendingThread) throw new Error('No selected pending Thread');
      await newThread();
      await wait(() => document.body.textContent?.includes('Start a conversation with the agent.') && !button('Allow once'));
      const previousThread = document.querySelector<HTMLButtonElement>(`[data-thread-id="${CSS.escape(pendingThread)}"] button[aria-pressed]`);
      if (!previousThread) throw new Error('The pending Thread disappeared while inspecting another conversation');
      previousThread.click();
      await wait(() => button('Allow once'));
      button('Allow once')!.click();
      await wait(() => document.body.textContent?.includes('PERMISSION_ACCEPTED'));
    } else {
      await wait(() => [...document.querySelectorAll('[data-slot="message"][data-align="start"]')].some((el) => el.textContent?.trim() === 'WEAVE_DESKTOP_REAL_PROVIDER_OK') && button('Send message') && !button('Stop response'));
    }
    stage = 'terminal';
    const nativeSurface = () => [...nativeTerminalAcceptance.entries()].find(([element]) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
    const terminalText = async () => nativeSurface() ? await nativeSurface()![1].read() : '';
    await wait(nativeSurface);
    await wait(async () => (await terminalText()).trim());
    const terminalId = document.querySelector('section[data-terminal-id]')?.getAttribute('data-terminal-id');
    if (!terminalId) throw new Error('No terminal session identity');
    const terminalBounds = nativeSurface()![0].getBoundingClientRect();
    if (terminalBounds.width < 200 || terminalBounds.height < 100 || terminalBounds.right > innerWidth + 1) throw new Error('Terminal is not visibly laid out in the application window.');
    if (nativeSurface()) {
      stage = 'persistent split and maximize';
      const original = nativeSurface()![0];
      const maximize = () => original.closest('section[data-terminal-id]')!.querySelector<HTMLButtonElement>('[aria-label="Maximize terminal"], [aria-label="Restore terminal"]')!;
      button('Split right')!.click();
      await wait(() => document.querySelectorAll('section[data-terminal-id]').length === 2);
      stage = 'pane focus and inactive appearance';
      // Let the desktop driver expose its window before testing AppKit focus.
      if (!state.alphaAcceptanceNativeSmoke) {
        state.alphaAcceptanceStage = 'native-pane-focus';
        await wait(() => state.alphaAcceptanceStage === undefined);
      }
      await wait(() => nativeTerminalAcceptance.size === 2);
      const paneId = original.closest('section[data-terminal-id]')!.getAttribute('aria-label')!.replace('Terminal pane ', '');
      document.querySelector<HTMLButtonElement>(`[data-pane-id="${CSS.escape(paneId)}"] button`)!.click();
      await wait(() => original.closest('section[data-focused="true"]'));
      await wait(async () => { try { await nativeTerminalAcceptance.get(original)!.focus(); return true; } catch { return false; } });
      const activeTerminal = original.closest('section[data-terminal-id]')!;
      const selectedAgent = document.querySelector<HTMLButtonElement>('[data-thread-id] button[aria-pressed="true"]');
      if (!selectedAgent) throw new Error('No agent to exercise focus handoff');
      stage = 'native terminal to composer focus';
      selectedAgent.click();
      const composer = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]');
      await wait(() => composer() && document.activeElement === composer() && activeTerminal.getAttribute('data-agent-focused') === 'true');
      await wait(() => !selectedAgent.querySelector('[data-state="completed"]'));
      if (activeTerminal.hasAttribute('data-dimmed')) throw new Error('The active terminal dimmed while the agent owned focus');
      if (!document.querySelector('section[data-terminal-id][data-dimmed="true"]')) throw new Error('Inactive terminal did not dim');
      const inactiveRail = document.querySelector<HTMLElement>('section[data-dimmed="true"] [data-slot="terminal-rail-dim"]')!;
      if (getComputedStyle(inactiveRail).opacity !== '0.4' || getComputedStyle(inactiveRail).pointerEvents !== 'none') throw new Error('Inactive terminal header must dim by 40% and remain clickable');
      if (getComputedStyle(activeTerminal.querySelector('[data-slot="terminal-rail-dim"]')!).opacity !== '0') throw new Error('Active terminal header dimmed while the agent owned focus');
      const frame = activeTerminal.querySelector<HTMLElement>('[data-slot="terminal-focus-border"]')!;
      if (getComputedStyle(frame).borderTopLeftRadius !== '0px') throw new Error('Terminal pane frame is not square');
      const agentFrame = document.querySelector<HTMLElement>('[data-slot="thread-pane"]')!;
      if (getComputedStyle(agentFrame, '::after').borderTopLeftRadius !== '0px') throw new Error('Agent pane frame is not square');
      const agentOutline = getComputedStyle(agentFrame, '::before');
      const headerHeight = agentFrame.querySelector('[data-slot="thread-top-rail"]')!.getBoundingClientRect().height;
      if (Number.parseFloat(agentOutline.top) !== headerHeight || agentOutline.borderTopWidth !== '1px') throw new Error('Agent top border does not run below its header rail');
      await wait(windowCornersMatch);
      stage = 'menu focus restoration';
      button('Sidebar actions')!.click(); await wait(() => document.querySelector('[role="menu"]'));
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(() => !document.querySelector('[role="menu"]') && document.activeElement === composer());
      const collapse = document.querySelector<HTMLButtonElement>(`[data-workspace-id="${CSS.escape(originalWorkspace)}"] button[aria-expanded]`)!;
      stage = 'sidebar focus restoration';
      collapse.focus(); collapse.click();
      await wait(() => document.activeElement === composer());
      collapse.click();
      if (state.alphaAcceptanceNativeSmoke) {
        stage = 'composer keyboard dismissal';
        state.alphaAcceptanceKeyboardDismissal = undefined;
        state.alphaAcceptanceStage = 'dismiss-composer-keyboard';
        await wait(() => state.alphaAcceptanceKeyboardDismissal !== undefined);
        if (!state.alphaAcceptanceKeyboardDismissal) throw new Error('Composer keyboard reopened after UIKit dismissed it');
        state.alphaAcceptanceStage = undefined;
        stage = 'iPad window corner after keyboard dismissal';
        await wait(() => windowCornersMatch() && outsideBottomRightRadius > 0);
        selectedAgent.click();
        await wait(() => document.activeElement === composer());
      }
      await nativeTerminalAcceptance.get(original)!.focus();
      await wait(() => activeTerminal.getAttribute('data-agent-focused') !== 'true');
      stage = 'persistent split and maximize';
      maximize().click(); await wait(() => original.getBoundingClientRect().width >= terminalBounds.width - 10);
      maximize().click(); await wait(() => original.getBoundingClientRect().width < terminalBounds.width - 10);
      maximize().click(); await wait(() => original.getBoundingClientRect().width >= terminalBounds.width - 10);
      if (nativeSurface()?.[0] !== original) throw new Error('Layout recreated the native terminal');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await wait(async () => { try { await nativeSurface()![1].focus(); return true; } catch { return false; } });
    if (state.alphaAcceptanceNativeSmoke) {
      stage = 'terminal keyboard dismissal';
      state.alphaAcceptanceKeyboardDismissal = undefined;
      state.alphaAcceptanceStage = 'dismiss-terminal-keyboard';
      await wait(() => state.alphaAcceptanceKeyboardDismissal !== undefined);
      if (!state.alphaAcceptanceKeyboardDismissal) throw new Error('Terminal keyboard reopened after UIKit dismissed it');
      state.alphaAcceptanceStage = undefined;
      await nativeSurface()![1].focus();
    }
    (window as unknown as { alphaAcceptanceFocusTerminal?: () => Promise<void> }).alphaAcceptanceFocusTerminal = async () => { await nativeSurface()![1].focus(); };
    state.alphaAcceptanceStage = 'native-terminal';
    stage = 'native terminal input and paste';
    await wait(async () => (await terminalText()).split('\n').some((line) => line.trim() === 'WEAVE_NATIVE_PASTE_OK'));
    state.alphaAcceptanceStage = 'native-neovim';
    stage = 'Neovim startup';
    await wait(async () => (await terminalText()).includes('[No Name]'));
    state.alphaAcceptanceStage = 'native-neovim-input';
    stage = 'Neovim';
    await wait(async () => { const text = await terminalText(); return text.includes('WEAVE_NEOVIM_INPUT') && text.includes('-- INSERT --'); });
    state.alphaAcceptanceStage = 'native-finish';
    await wait(() => state.alphaAcceptanceStage === 'native-finished');
    stage = 'reattach running terminal after workspace switch';
    await openWorkspace();
    await wait(() => !document.querySelector(`section[data-terminal-id="${CSS.escape(terminalId)}"]`));
    document.querySelector<HTMLButtonElement>(`[data-workspace-id="${CSS.escape(originalWorkspace)}"] [aria-label="Workspace ${CSS.escape(input.workspaceName)}"]`)!.click();
    await wait(async () => { const text = await terminalText(); return text.includes('WEAVE_NEOVIM_INPUT') && text.includes('-- INSERT --'); });
    await wait(async () => { try { await nativeSurface()![1].focus(); return true; } catch { return false; } });
    state.alphaAcceptanceStage = 'native-reattached-input';
    stage = 'input after terminal reattachment';
    await wait(async () => (await terminalText()).includes('WEAVE_NEOVIM_INPUT_REATTACHED'));
    if (nativeSurface()) {
      stage = 'native IME composition'; state.alphaAcceptanceStage = 'native-composition';
      await wait(async () => (await terminalText()).includes('界é'));
    }

    stage = 'top rail controls';
    if (document.querySelector('[data-slot="global-bottom-rail"]')) throw new Error('Bottom rail is still mounted');
    if (button('Agent conversation')) throw new Error('Redundant agent toggle is still in the sidebar rail');
    if (!button('Connections')?.closest('[data-slot="sidebar-header"]')) throw new Error('Connections must remain in the sidebar rail');
    button('Toggle threads')!.click();
    await wait(() => !button('Connections'));
    const sidebarToggle = button('Toggle threads')!;
    const overlay = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
    // The button hit area now extends into the overlay's trailing padding;
    // its visible icon must still clear the native window controls.
    if (sidebarToggle.querySelector('svg')!.getBoundingClientRect().left < (overlay?.visible ? overlay.getTitlebarAreaRect().x : 0)) throw new Error('Sidebar icon overlaps native window controls');
    sidebarToggle.click(); await wait(() => button('Connections'));
    await wait(async () => { try { await nativeSurface()![1].focus(); return true; } catch { return false; } });


    await wait(windowCornersMatch);
    if (document.querySelector('[data-slot="browser-pane"], [data-slot="editor-pane"], [data-symbol="project-pane"]')) throw new Error('Deferred surface mounted');
    return { passed: true, pairedOrReconnected: true, acpPrompt: true, permission: Boolean(input.permission), permissionSurvivesConversationSwitch: Boolean(input.permission), nativeTerminalPaste: true, neovimInput: true, runningTerminalReattached: true, nativePaneLifetime: Boolean(nativeSurface()), paneFocusRestoration: true, ...(state.alphaAcceptanceNativeSmoke ? { softwareKeyboardDismissal: true } : {}), activeTerminalUndimmed: true, squarePaneBorders: true, outsideBottomRightRadius, nativeCompositionCommit: Boolean(nativeSurface()), deferredSurfacesAbsent: true, width: innerWidth, height: innerHeight };
  } catch (error) { return { passed: false, stage, error: String(error), nativeSurfaces: await Promise.all([...nativeTerminalAcceptance.entries()].map(async ([element, surface]) => ({ bounds: element.getBoundingClientRect().toJSON(), text: await surface.read().catch(String) }))), visibleControls: [...document.querySelectorAll<HTMLElement>('button, [role=menuitem]')].filter(el => el.getBoundingClientRect().height > 0).map(el => ({ label: el.getAttribute('aria-label') ?? el.textContent?.trim(), titles: [...el.querySelectorAll('[title]')].map(child => child.getAttribute('title')) })) }; }
}
