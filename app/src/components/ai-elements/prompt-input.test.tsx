import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FormEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PromptInput, PromptInputTextarea } from './prompt-input';

describe('PromptInput', () => {
  it('submits on Enter, preserves Shift+Enter, and ignores IME confirmation', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <PromptInput aria-label="Composer" onSubmit={onSubmit}>
        <PromptInputTextarea aria-label="Prompt" />
        <button type="submit">Send</button>
      </PromptInput>,
    );
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });

    await user.type(textarea, 'hello{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await user.type(textarea, '{Shift>}{Enter}{/Shift}');
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
