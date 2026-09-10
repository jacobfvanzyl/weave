import { nativeTerminalAcceptance } from '@/terminal/native-terminal';
// Included only in explicitly built acceptance artifacts.
export async function runShellAcceptance() {
  let stage = "startup";
  const waitFor = async (predicate: () => unknown) => {
    for (let n = 0; n < 100; n++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Shell acceptance condition timed out.');
  };
  const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  try {
    await waitFor(() => button('Show Terminal Pane') || button('Hide Terminal Pane'));
    stage = 'terminal mount';
    if (document.querySelector('[data-slot="browser-pane"], [data-slot="editor-pane"], [data-symbol="project-pane"], [data-symbol="browser-pane"]')) throw new Error('Deferred surface is active.');
    button('Show Terminal Pane')?.click();
    await waitFor(() => document.querySelector('.xterm-screen'));
    const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
    if (screen.width < 100 || screen.height < 30) throw new Error('Terminal geometry is invalid.');
    stage = 'terminal input';
    const input = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    await waitFor(() => document.querySelector('.xterm-rows')?.textContent?.includes('$'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', keyCode: 88, which: 88, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'x', code: 'KeyX', keyCode: 120, charCode: 120, which: 120, bubbles: true }));
    await waitFor(() => document.querySelector('.xterm-rows')?.textContent?.includes('$ x'));
    stage = 'composer';
    button('Hide Terminal Pane')!.click();
    const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'WVE shell acceptance');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => button('Send message') && !button('Send message')!.disabled);
    button('Send message')!.click();
    await waitFor(() => button('Stop response'));
    button('Stop response')!.click();
    await waitFor(() => button('Send message'));
    button('Show Terminal Pane')?.click();
    await waitFor(() => document.querySelector('.xterm-screen'));
    return { passed: true, deferredSurfacesAbsent: true, terminalInputAndGeometry: true, composerSendAndCancel: true, width: innerWidth, height: innerHeight };
  } catch (error) {
    return { passed: false, stage, error: String(error) };
  }
}

export type LiveAcceptanceInput = { hostUrl: string; pairingToken?: string; workspaceName: string; permission?: boolean };
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
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role=menuitem]')].find((el) => el.getAttribute('aria-label') === name || el.textContent?.trim() === name);
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
    stage = 'create thread';
    await wait(() => button('New agent thread'));
    button('New agent thread')!.click();
    await wait(() => button(`New thread in ${input.workspaceName}`) && !button(`New thread in ${input.workspaceName}`)!.disabled);
    button(`New thread in ${input.workspaceName}`)!.click();
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
      button('New agent thread')!.click();
      await wait(() => button(`New thread in ${input.workspaceName}`));
      button(`New thread in ${input.workspaceName}`)!.click();
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
    button('Open…')!.click();
    await wait(() => button(`Open workspace in ${input.workspaceName}`));
    button(`Open workspace in ${input.workspaceName}`)!.click();
    await wait(() => button(`Workspace actions for ${input.workspaceName}`));
    button(`Workspace actions for ${input.workspaceName}`)!.click();
    await wait(() => button('New terminal workspace'));
    const previousContext = document.querySelector('[aria-label="Active terminal context"]')?.textContent;
    button('New terminal workspace')!.click();
    await wait(() => document.querySelector('[aria-label="Active terminal context"]')?.textContent !== previousContext);
    await wait(() => button('Start terminal') && !button('Start terminal')!.disabled);
    button('Start terminal')!.click();
    const nativeSurface = () => nativeTerminalAcceptance.entries().next().value as [HTMLElement, { focus(): Promise<void>; read(): Promise<string> }] | undefined;
    const terminalText = async () => nativeSurface() ? await nativeSurface()![1].read() : document.querySelector('.xterm-rows')?.textContent ?? '';
    await wait(async () => (await terminalText()).trim());
    const terminalId = document.querySelector('section[data-terminal-id]')?.getAttribute('data-terminal-id');
    if (!terminalId) throw new Error('No terminal session identity');
    const terminalBounds = (nativeSurface()?.[0] ?? document.querySelector('.xterm-screen'))!.getBoundingClientRect();
    if (terminalBounds.width < 200 || terminalBounds.height < 100 || terminalBounds.right > innerWidth + 1) throw new Error('Terminal is not visibly laid out in the application window.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (nativeSurface()) await nativeSurface()![1].focus();
    else document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.focus();
    state.alphaAcceptanceStage = 'native-terminal';
    stage = 'native terminal input and paste';
    await wait(async () => nativeSurface() ? (await terminalText()).split('\n').some((line) => line.trim() === 'WEAVE_NATIVE_PASTE_OK') : [...document.querySelectorAll('.xterm-rows > div')].some((el) => el.textContent?.trim() === 'WEAVE_NATIVE_PASTE_OK'));
    state.alphaAcceptanceStage = 'native-neovim';
    stage = 'Neovim startup';
    await wait(async () => (await terminalText()).includes('[No Name]'));
    state.alphaAcceptanceStage = 'native-neovim-input';
    stage = 'Neovim';
    await wait(async () => { const text = await terminalText(); return text.includes('WEAVE_NEOVIM_INPUT') && text.includes('-- INSERT --'); });
    state.alphaAcceptanceStage = 'native-finish';
    await wait(() => state.alphaAcceptanceStage === 'native-finished');
    stage = 'reattach running terminal in another arrangement';
    button(`Workspace actions for ${input.workspaceName}`)!.click();
    await wait(() => button('New terminal workspace'));
    button('New terminal workspace')!.click();
    await wait(() => button('Use running terminal…'));
    button('Use running terminal…')!.click();
    const runningTerminal = () => document.querySelector<HTMLButtonElement>(`button[data-terminal-id="${CSS.escape(terminalId)}"]`);
    await wait(runningTerminal);
    runningTerminal()!.click();
    await wait(() => !document.querySelector('[role="dialog"]'));
    await wait(async () => { const text = await terminalText(); return text.includes('WEAVE_NEOVIM_INPUT') && text.includes('-- INSERT --'); });
    if (nativeSurface()) await nativeSurface()![1].focus();
    else document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.focus();
    state.alphaAcceptanceStage = 'native-reattached-input';
    stage = 'input after terminal reattachment';
    await wait(async () => (await terminalText()).includes('WEAVE_NEOVIM_INPUT_REATTACHED'));

    if (document.querySelector('[data-slot="browser-pane"], [data-slot="editor-pane"], [data-symbol="project-pane"]')) throw new Error('Deferred surface mounted');
    return { passed: true, pairedOrReconnected: true, acpPrompt: true, permission: Boolean(input.permission), permissionSurvivesConversationSwitch: Boolean(input.permission), nativeTerminalPaste: true, neovimInput: true, runningTerminalReattached: true, deferredSurfacesAbsent: true, width: innerWidth, height: innerHeight };
  } catch (error) { return { passed: false, stage, error: String(error) }; }
}
