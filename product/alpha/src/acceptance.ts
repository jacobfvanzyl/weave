// Included only in explicitly built acceptance artifacts.
export async function runShellAcceptance() {
  let stage = "startup";
  const waitFor = async (predicate: () => unknown) => {
    for (let n = 0; n < 100; n++) {
      if (predicate()) return;
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
