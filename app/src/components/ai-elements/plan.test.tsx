import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Plan, PlanContent, PlanHeader, PlanTrigger } from './plan';

describe('Plan', () => {
  it('exposes plan content through a keyboard-accessible disclosure', async () => {
    const user = userEvent.setup();
    render(
      <Plan aria-label="Agent plan" defaultOpen>
        <PlanHeader>
          Plan
          <PlanTrigger />
        </PlanHeader>
        <PlanContent>Ship the ACP adapter</PlanContent>
      </Plan>,
    );

    expect(screen.getByText('Ship the ACP adapter')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Toggle plan' }));
    expect(screen.queryByText('Ship the ACP adapter')).not.toBeInTheDocument();
  });
});
