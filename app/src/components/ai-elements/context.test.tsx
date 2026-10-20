import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Context, ContextContent, ContextTrigger } from './context';

describe('Context', () => {
  it('keeps usage compact while exposing only supplied ACP details to keyboard users', async () => {
    const user = userEvent.setup();
    render(
      <Context
        cost={{ amount: 0.42, currency: 'USD' }}
        maxTokens={32_768}
        usedTokens={4_096}
      >
        <ContextTrigger />
        <ContextContent />
      </Context>,
    );

    const trigger = screen.getByRole('button', { name: 'Context usage' });
    expect(screen.queryByText('4,096 of 32,768 tokens')).not.toBeInTheDocument();

    trigger.focus();
    expect(await screen.findByText('4,096 of 32,768 tokens')).toBeVisible();
    expect(screen.getByText('$0.42')).toBeVisible();
    await user.keyboard('{Escape}');
  });
});
