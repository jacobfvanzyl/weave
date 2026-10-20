import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ActivityIndicator } from './activity-indicator';

it('shows waiting before running, and an unread turn only when idle', () => {
  const { rerender, container } = render(<ActivityIndicator activity='waiting' unread />);
  expect(screen.getByRole('img', { name: 'Waiting for you' })).toBeInTheDocument();
  rerender(<ActivityIndicator activity='running' />);
  expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument();
  rerender(<ActivityIndicator activity='idle' unread />);
  expect(screen.getByRole('img', { name: 'Finished since you last looked' })).toBeInTheDocument();
  rerender(<ActivityIndicator activity='idle' />);
  expect(container).toBeEmptyDOMElement();
});
