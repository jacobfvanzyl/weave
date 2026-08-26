import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle,
} from './confirmation';

describe('Confirmation', () => {
  it('renders caller-owned permission choices without reducing them to approve or reject', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <Confirmation>
        <ConfirmationTitle>Permission required</ConfirmationTitle>
        <ConfirmationActions>
          <ConfirmationAction onClick={() => select('once')}>Allow once</ConfirmationAction>
          <ConfirmationAction onClick={() => select('session')}>Allow for session</ConfirmationAction>
          <ConfirmationAction onClick={() => select('reject')}>Reject</ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>,
    );

    await user.click(screen.getByRole('button', { name: 'Allow for session' }));
    expect(select).toHaveBeenCalledWith('session');
  });
});
