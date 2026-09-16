import { Keyboard } from '@capacitor/keyboard';
import { nativeTerminalAcceptance } from '@/terminal/native-terminal';
import { runBrowserScrollAcceptance } from '@/browser/scroll-acceptance';
// Included only in explicitly built acceptance artifacts.
export type LiveAcceptanceInput = { browserKeyboard?: boolean | 'smoke'; browserBenchmark?: { durationMs: number; animation: boolean }; browserUrl?: string; browserHostId?: string; hostUrl: string; pairingToken?: string; workspaceName: string; directory?: string; permission?: boolean };
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
    return [...document.querySelectorAll<HTMLElement>('[data-slot="pane-focus-border"]')].filter(el => el.getBoundingClientRect().height > 0).every(el => {
      const rect = el.getBoundingClientRect();
      const outside = Math.abs(rect.right - innerWidth) < 1.5 && Math.abs(rect.bottom - innerHeight) < 1.5;
      const style = getComputedStyle(el);
      const expected = outside ? radius : 0;
      return parseFloat(style.borderBottomRightRadius) === expected && parseFloat(style.borderBottomLeftRadius) === 0 && (el.dataset.slot !== 'thread-pane' || parseFloat(getComputedStyle(el, '::before').borderBottomRightRadius) === expected);
    });
  };
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role=menuitem]')].find((el) => el.getBoundingClientRect().height > 0 && !el.matches(':disabled, [aria-disabled="true"], [data-disabled]') && (el.getAttribute('aria-label') === name || el.textContent?.trim() === name));
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
    if (input.browserUrl) {
      const previousPages=new Set([...document.querySelectorAll<HTMLElement>('[data-browser-page]')].map(el=>el.dataset.browserPage));
      stage = 'Browser Workspace menu';
      await wait(() => button('Sidebar actions')); button('Sidebar actions')!.click();
      await wait(() => button('New workspace…')); button('New workspace…')!.click();
      const browserItem=()=>input.browserHostId ? document.querySelector<HTMLElement>(`[data-browser-host="${input.browserHostId}"]`) : button('Browser');
      await wait(()=>browserItem() && !browserItem()!.matches(':disabled, [aria-disabled="true"], [data-disabled]')); browserItem()!.click();
      // Synthetic menu selection does not always dismiss nested Base UI menus.
      for (let n = 0; n < 3; n++) {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true }));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      stage = 'blank Browser address';
      if(!input.browserHostId)throw new Error('Fixture Host identity is required');
      const createdPane=()=>[...document.querySelectorAll<HTMLElement>('[data-browser-page]')].find(el=>el.dataset.browserHost===input.browserHostId && !previousPages.has(el.dataset.browserPage) && el.checkVisibility());
      await wait(createdPane);
      const pane=createdPane()!;
      const address=pane.querySelector<HTMLInputElement>('[aria-label="Browser address"]');
      if(!address || address.value) throw new Error('New test Pane must have a blank address');
      await wait(()=>!pane.querySelector<HTMLButtonElement>('[aria-label="Reload"]')?.disabled);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(address,input.browserUrl);
      address.dispatchEvent(new Event('input',{bubbles:true}));
      address.form!.requestSubmit();
      stage = 'native Browser framebuffer';
      await wait(() => Number(pane.querySelector<HTMLElement>('[data-slot="native-browser-input"]')?.dataset.frameWidth) > 0);
      const browser=pane.querySelector<HTMLTextAreaElement>('[data-slot="native-browser-input"]')!;
      if(input.browserKeyboard){
        browser.focus();state.alphaAcceptanceStage='browser-keyboard';
        if(input.browserKeyboard==='smoke'){
          const keyboardEvents:{event:string;height?:number}[]=[];
          const show=await Keyboard.addListener('keyboardDidShow',info=>keyboardEvents.push({event:'show',height:info.keyboardHeight}));
          const hide=await Keyboard.addListener('keyboardDidHide',()=>keyboardEvents.push({event:'hide'}));
          const pause=()=>new Promise(resolve=>setTimeout(resolve,700));
          try {
          await pause();const baseline=innerHeight;
          const tap=async(x:number,y:number)=>{
            await wait(()=>browser.dataset.frameWidth===browser.dataset.expectedFrameWidth && browser.dataset.frameHeight===browser.dataset.expectedFrameHeight);
            browser.focus();const r=browser.getBoundingClientRect();
            for(const type of ['pointerdown','pointerup'])browser.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:r.x+x,clientY:r.y+y,pointerType:'touch',pointerId:1,button:0,buttons:type==='pointerdown'?1:0}));
          };
          if(!browser.readOnly)throw new Error('Pane focus enabled software input');
          await tap(400,250);await pause();if(!browser.readOnly || innerHeight<baseline-100)throw new Error('Ordinary tap opened keyboard');
          await tap(80,60);stage='editable keyboard';await wait(()=>!browser.readOnly);stage='keyboard viewport resize';await wait(()=>innerHeight<baseline-100);
          const keyboardHeight=baseline-innerHeight;
          await wait(()=>browser.dataset.frameWidth===browser.dataset.expectedFrameWidth && browser.dataset.frameHeight===browser.dataset.expectedFrameHeight);
          browser.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'Weave keyboard'}));await pause();
          await Keyboard.hide();await wait(()=>browser.readOnly && innerHeight>baseline-50);await pause();if(!browser.readOnly)throw new Error('Dismissed keyboard reopened');
          await tap(80,60);stage='reopen keyboard';await wait(()=>!browser.readOnly && innerHeight<baseline-100);
          await tap(400,250);stage='hide on body';await wait(()=>browser.readOnly && innerHeight>baseline-50);
          await tap(80,140);await pause();if(!browser.readOnly || innerHeight<baseline-100)throw new Error('Readonly field opened keyboard');
          return {passed:true,browserKeyboard:true,driver:'in-process WebKit and real viewport resize; not XCTest touch',keyboardHeight,keyboardEvents};
          } catch(error) {throw new Error(`${error}; readonly=${browser.readOnly}; focused=${document.activeElement===browser}; height=${innerHeight}; keyboard=${JSON.stringify(keyboardEvents)}; input=${JSON.stringify(browser.dataset)}`);} finally {await show.remove();await hide.remove();}
        }
        const done=document.createElement('button');done.textContent='Finish browser keyboard test';done.setAttribute('aria-label','Finish browser keyboard test');done.style.cssText='position:fixed;top:25px;right:20px;z-index:99999;background:white;color:black';document.body.append(done);
        try {await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Keyboard test timed out')),120000);done.onclick=()=>{clearTimeout(timer);resolve();};});}
        finally{done.remove();}
        return {passed:true,browserKeyboard:true};
      }
      if (input.browserBenchmark) return await runBrowserScrollAcceptance(browser, input.browserBenchmark.durationMs, input.browserBenchmark.animation);
      await new Promise(resolve => setTimeout(resolve,500));
      const rect = browser.getBoundingClientRect();
      browser.focus();
      for (const type of ['pointerdown','pointerup']) browser.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:rect.x+50,clientY:rect.y+60,button:0,buttons:type==='pointerdown'?1:0,pointerId:1}));
      await new Promise(resolve => setTimeout(resolve,500));
      for (const type of ['pointerdown','pointerup']) browser.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:rect.x+50,clientY:rect.y+145,button:0,buttons:type==='pointerdown'?1:0,pointerId:1}));
      browser.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'Weave ✓'}));
      await new Promise(resolve => setTimeout(resolve,750));
      return {passed:true,browserTextDispatched:true,browserBlankStart:true,nativeBrowserFrame:true,width:Number(browser.dataset.frameWidth),height:Number(browser.dataset.frameHeight),browserPointerDispatched:true};
    }
    const openWorkspace = async () => {
      await wait(() => button('Sidebar actions')); button('Sidebar actions')!.click();
      await wait(() => button('New workspace…')); button('New workspace…')!.click();
      const directory = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"] [title]')].find(el => el.getBoundingClientRect().height > 0 && (input.directory ? el.getAttribute('title') === input.directory : el.getAttribute('title')?.endsWith('/workspace')))?.closest<HTMLElement>('[role="menuitem"]');
      await wait(() => directory() && !directory()!.matches(':disabled, [aria-disabled="true"], [data-disabled]'));
      const before = new Set([...document.querySelectorAll('[data-workspace-id]')].map(el => el.getAttribute('data-workspace-id')));
      await new Promise(resolve => setTimeout(resolve, 250));
      directory()!.focus(); directory()!.click();
      let created: Element | undefined;
      await wait(() => { created = [...document.querySelectorAll('[data-workspace-id]')].find(el => !before.has(el.getAttribute('data-workspace-id')) && el.querySelector('[aria-label^="Workspace "][aria-pressed="true"]')); return created; });
      return created!.getAttribute('data-workspace-id')!;
    };
    stage = 'create workspace';
    const originalWorkspace = await openWorkspace();
    const newThread = async () => {
      const previousThread = document.querySelector('[data-thread-id]:has([aria-pressed="true"])')?.getAttribute('data-thread-id');
      document.querySelector<HTMLButtonElement>(`[data-workspace-id="${CSS.escape(originalWorkspace)}"] [aria-label="Workspace actions for ${CSS.escape(input.workspaceName)}"]`)!.click();
      await wait(() => button('New agent thread'));
      await new Promise(resolve => setTimeout(resolve, 250));
      button('New agent thread')!.focus(); button('New agent thread')!.click();
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
    stage = 'archive empty Agent Pane';
    const discardedDraft = document.querySelector('[data-thread-id]:has([aria-pressed="true"])')!.getAttribute('data-thread-id')!;
    button('Archive agent pane')!.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    if (button('Stop and archive')) button('Stop and archive')!.click();
    await wait(() => !document.querySelector(`[data-thread-id="${CSS.escape(discardedDraft)}"]`) && !document.querySelector('[data-slot="agent-pane-content"]'));
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
      await wait(() => document.querySelectorAll('[data-slot="agent-pane-content"]').length === 2 && document.body.textContent?.includes('Start a conversation with the agent.') && button('Allow once'));
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
      original.closest('section[data-terminal-id]')!.querySelector<HTMLButtonElement>('[aria-label="Split pane"]')!.click();
      await wait(() => Boolean(button('Right'))); button('Right')!.click();
      await wait(() => Boolean(button('Terminal'))); button('Terminal')!.click();
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
      const selectedAgent = document.querySelector<HTMLButtonElement>(`[data-workspace-id="${CSS.escape(originalWorkspace)}"] [data-thread-id] button[aria-pressed]`);
      if (!selectedAgent) throw new Error('No agent to exercise focus handoff');
      stage = 'native terminal to composer focus';
      selectedAgent.click();
      const agentId = selectedAgent.closest('[data-thread-id]')!.getAttribute('data-thread-id')!;
      const composer = () => document.querySelector<HTMLTextAreaElement>(`section[data-thread-id="${CSS.escape(agentId)}"] [aria-label="Message agent"]`);
      await wait(composer);
      // On touch clients navigation intentionally does not request a keyboard.
      const focusComposer = () => {
        const element = composer()!;
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.focus();
      };
      focusComposer();
      await wait(() => document.activeElement === composer() && activeTerminal.hasAttribute('data-dimmed'));
      await wait(() => !selectedAgent.querySelector('[data-state="completed"]'));
      if (!document.querySelector('section[data-terminal-id][data-dimmed="true"]')) throw new Error('Inactive terminal did not dim');
      const frame = activeTerminal.querySelector<HTMLElement>('[data-slot="pane-focus-border"]')!;
      if (getComputedStyle(frame).borderTopLeftRadius !== '0px') throw new Error('Terminal pane frame is not square');
      const agentFrame = composer()!.closest('[data-slot="pane-focus-border"]')!;
      if (getComputedStyle(agentFrame).borderTopLeftRadius !== '0px') throw new Error('Agent pane frame is not square');
      const rails = [...document.querySelectorAll<HTMLElement>('[data-slot="pane-top-rail"]')].filter(rail => rail.getBoundingClientRect().height > 0);
      if (rails.length < 3 || new Set(rails.map(rail => rail.getBoundingClientRect().height)).size !== 1) throw new Error('Pane rails do not share their geometry');
      if (getComputedStyle(frame).borderColor === getComputedStyle(agentFrame).borderColor) throw new Error('Inactive and focused Panes have identical borders');
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
        selectedAgent.click(); focusComposer();
        await wait(() => document.activeElement === composer());
      }
      await nativeTerminalAcceptance.get(original)!.focus();
      await wait(() => activeTerminal.getAttribute('data-focused') === 'true');
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
    return { passed: true, pairedOrReconnected: true, acpPrompt: true, permission: Boolean(input.permission), permissionSurvivesConversationSwitch: Boolean(input.permission), nativeTerminalPaste: true, neovimInput: true, runningTerminalReattached: true, nativePaneLifetime: Boolean(nativeSurface()), paneFocusRestoration: true, ...(state.alphaAcceptanceNativeSmoke ? { softwareKeyboardDismissal: true } : {}), singleFocusedPane: true, sharedPaneRails: true, squarePaneBorders: true, outsideBottomRightRadius, nativeCompositionCommit: Boolean(nativeSurface()), deferredSurfacesAbsent: true, width: innerWidth, height: innerHeight };
  } catch (error) { return { passed: false, stage, error: String(error), nativeSurfaces: await Promise.all([...nativeTerminalAcceptance.entries()].map(async ([element, surface]) => ({ bounds: element.getBoundingClientRect().toJSON(), text: await surface.read().catch(String) }))), visibleControls: [...document.querySelectorAll<HTMLElement>('button, [role=menuitem]')].filter(el => el.getBoundingClientRect().height > 0).map(el => ({ label: el.getAttribute('aria-label') ?? el.textContent?.trim(), titles: [...el.querySelectorAll('[title]')].map(child => child.getAttribute('title')) })) }; }
}
