import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';

import { Button } from './button';

const meta = {
  title: 'Harness/Weave client',
  component: Button,
  args: {
    children: 'Open workspace',
  },
  render: args => (
    <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-xl">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Storybook prototype harness
        </p>
        <h1 className="mb-3 text-2xl font-semibold">Weave shared-client canvas</h1>
        <p className="mb-6 text-sm leading-6 text-muted-foreground">
          Real client typography, theme variables, Tailwind utilities, and a shared Button primitive.
        </p>
        <Button {...args} />
      </section>
    </main>
  ),
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Smoke: Story = {
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Open workspace' });

    await expect(button).toBeVisible();
    await userEvent.click(button);
    await expect(button).toHaveFocus();
  },
};
