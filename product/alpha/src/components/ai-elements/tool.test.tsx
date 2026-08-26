import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tool, ToolContent, ToolHeader } from './tool';

describe('Tool', () => {
  it('provides an accessible disclosure shell without prescribing protocol state', async () => {
    const user = userEvent.setup();
    render(
      <Tool defaultOpen>
        <ToolHeader>Read file — completed</ToolHeader>
        <ToolContent>/workspace/README.md</ToolContent>
      </Tool>,
    );

    const trigger = screen.getByRole('button', { name: 'Read file — completed' });
    expect(screen.getByText('/workspace/README.md')).toBeVisible();
    await user.click(trigger);
    expect(screen.queryByText('/workspace/README.md')).not.toBeInTheDocument();
  });
});
