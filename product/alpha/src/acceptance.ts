import { nativeTerminalAcceptance } from '@/terminal/native-terminal';
// Included only in explicitly built acceptance artifacts.
export type LiveAcceptanceInput = { hostUrl: string; pairingToken?: string; workspaceName: string; directory?: string; permission?: boolean };
export async function runLiveShellAcceptance(input: LiveAcceptanceInput) {
  let stage = 'pairing';
  const state = window as unknown as { alphaAcceptanceStage?: string; alphaAcceptanceDetail?: string };
  const wait = async (predicate: () => unknown) => {
    state.alphaAcceptanceDetail = stage;
    for (let n = 0; n < 600; n++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out at ${stage}`);
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
      await wait(() => button('Settings') || document.querySelector('#pairing-token'));
      button('Settings')?.click();
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
      document.querySelector<HTMLButtonElement>(`[data-workspace-id="${CSS.escape(originalWorkspace)}"] [aria-label="Workspace actions for ${CSS.escape(input.workspaceName)}"]`)!.click();
      await wait(() => button('New agent thread')); button('New agent thread')!.click();
      await wait(() => document.querySelector('[aria-label="Message agent"]') || document.querySelector('[role="dialog"]'));
      const choice = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button [title]')].find(el => input.directory ? el.getAttribute('title') === input.directory : el.getAttribute('title')?.endsWith('/workspace'))?.closest<HTMLButtonElement>('button');
      choice?.click();
    };
    stage = 'create thread';
    await newThread();
    await wait(() => document.querySelector('[aria-label="Message agent"]') && document.body.textContent?.includes('Start a conversation with the agent.'));
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
      maximize().click(); await wait(() => original.getBoundingClientRect().width >= terminalBounds.width - 10);
      maximize().click(); await wait(() => original.getBoundingClientRect().width < terminalBounds.width - 10);
      maximize().click(); await wait(() => original.getBoundingClientRect().width >= terminalBounds.width - 10);
      if (nativeSurface()?.[0] !== original) throw new Error('Layout recreated the native terminal');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await wait(async () => { try { await nativeSurface()![1].focus(); return true; } catch { return false; } });
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


    if (document.querySelector('[data-slot="browser-pane"], [data-slot="editor-pane"], [data-symbol="project-pane"]')) throw new Error('Deferred surface mounted');
    return { passed: true, pairedOrReconnected: true, acpPrompt: true, permission: Boolean(input.permission), permissionSurvivesConversationSwitch: Boolean(input.permission), nativeTerminalPaste: true, neovimInput: true, runningTerminalReattached: true, nativePaneLifetime: Boolean(nativeSurface()), nativeCompositionCommit: Boolean(nativeSurface()), deferredSurfacesAbsent: true, width: innerWidth, height: innerHeight };
  } catch (error) { return { passed: false, stage, error: String(error), nativeSurfaces: await Promise.all([...nativeTerminalAcceptance.entries()].map(async ([element, surface]) => ({ bounds: element.getBoundingClientRect().toJSON(), text: await surface.read().catch(String) }))), visibleControls: [...document.querySelectorAll<HTMLElement>('button, [role=menuitem]')].filter(el => el.getBoundingClientRect().height > 0).map(el => ({ label: el.getAttribute('aria-label') ?? el.textContent?.trim(), titles: [...el.querySelectorAll('[title]')].map(child => child.getAttribute('title')) })) }; }
}
