// Form elicitations as agents ask them (WVE-155): picks that can be taken back, choices as lists,
// and each adapter's free text in place, answered as the adapter reads it. The forms are the fake
// agent's `/questions`, in claude-agent-acp 0.97.0's and codex-acp 2.3.0's shapes.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreateElicitationResponse, ElicitationSchema } from '@/host/protocol';
import { ElicitationView } from './elicitation-view';

const claude: ElicitationSchema = {
  type: 'object',
  properties: {
    question_0: {
      type: 'string',
      title: 'Database',
      description: 'Which database should the service use?',
      oneOf: [
        { const: 'Postgres', title: 'Postgres', description: 'Relational, with the tooling the team has' },
        { const: 'SQLite', title: 'SQLite', description: 'One file, no server' },
      ],
    },
    question_0_custom: {
      type: 'string',
      title: 'Other',
      description: 'Type your own answer, or add a note to the option you chose above (optional).',
    },
    question_1: {
      type: 'array',
      title: 'Checks',
      description: 'Which checks should run before each commit?',
      items: {
        anyOf: [
          { const: 'Tests', title: 'Tests' },
          { const: 'Lint', title: 'Lint', description: 'cargo clippy' },
          { const: 'Format', title: 'Format' },
        ],
      },
    },
    question_1_custom: {
      type: 'string',
      title: 'Other',
      description: 'Type your own answer to add to your selection above (optional).',
    },
  },
};

const codex: ElicitationSchema = {
  type: 'object',
  properties: {
    deploy_target: {
      type: 'string',
      title: 'Where should this deploy?',
      description: 'Deploy',
      _meta: { codex: { isOther: true } },
      oneOf: [
        { const: 'Staging', title: 'Staging', description: 'The shared staging cluster' },
        { const: 'Production', title: 'Production' },
        { const: 'None of the above', title: 'None of the above', description: 'Provide a different answer in the note field.' },
      ],
    },
    deploy_target_note: {
      type: 'string',
      title: 'Additional answer or note',
      _meta: { codex: { questionId: 'deploy_target', role: 'user_note' } },
    },
  },
  required: ['deploy_target'],
};

function ask(requestedSchema: ElicitationSchema, message = 'Please answer the following questions.') {
  const onRespond = vi.fn<(requestId: string, response: CreateElicitationResponse) => void>();
  render(
    <ElicitationView
      entry={{ id: 'e', kind: 'elicitation', requestId: 'q', status: 'pending', request: { mode: 'form', sessionId: 's', message, requestedSchema } }}
      onRespond={onRespond}
    />,
  );
  const user = userEvent.setup();
  const form = screen.getByRole('form', { name: message });
  return {
    user,
    form,
    question: (name: string) => within(form).getByRole('group', { name }),
    /** Submits, and gives what was sent, if anything was. */
    async submit() {
      onRespond.mockClear();
      await user.click(within(form).getByRole('button', { name: 'Submit' }));
      const [call] = onRespond.mock.calls;
      return call?.[1].action === 'accept' ? call[1].content : undefined;
    },
  };
}

describe('form elicitations', () => {
  it('takes back an optional pick and an optional yes/no, and only changes a required one', async () => {
    const { user, question, submit } = ask({
      type: 'object',
      properties: {
        color: { type: 'string', title: 'Color', enum: ['Red', 'Blue'] },
        env: { type: 'string', title: 'Environment', oneOf: [{ const: 'staging', title: 'Staging' }, { const: 'prod', title: 'Production' }] },
        news: { type: 'boolean', title: 'Newsletter', default: true },
      },
      required: ['env'],
    }, 'Set up');
    const red = within(question('Color')).getByRole('radio', { name: 'Red' });
    await user.click(red);
    expect(red).toBeChecked();
    await user.click(red);
    expect(red).not.toBeChecked();
    // Space does what a tap does.
    red.focus();
    await user.keyboard(' ');
    expect(red).toBeChecked();
    await user.keyboard(' ');
    expect(red).not.toBeChecked();

    const yes = within(question('Newsletter')).getByRole('radio', { name: 'Yes' });
    expect(yes).toBeChecked();
    await user.click(yes);
    expect(yes).not.toBeChecked();
    expect(within(question('Newsletter')).getByRole('radio', { name: 'No' })).not.toBeChecked();

    const staging = within(question('Environment')).getByRole('radio', { name: 'Staging' });
    await user.click(staging);
    await user.click(staging);
    expect(staging).toBeChecked();
    await user.click(within(question('Environment')).getByRole('radio', { name: 'Production' }));
    expect(staging).not.toBeChecked();

    expect(await submit()).toEqual({ env: 'prod' });
  });

  it('draws a choice as a list of its options, each with its description, and its Other as the last row', async () => {
    const { form, question } = ask(claude);
    const database = question('Database');
    expect(within(database).getAllByRole('radio')).toEqual(['Postgres', 'SQLite', 'Other']
      .map((name) => within(database).getByRole('radio', { name })));
    expect(within(database).getByText('Relational, with the tooling the team has')).toBeInTheDocument();
    expect(within(question('Checks')).getByText('cargo clippy')).toBeInTheDocument();
    // Each Other is its choice's, not a field of its own, and its adapter's hint isn't shown.
    expect(within(database).getByRole('textbox', { name: 'Other' })).toBeInTheDocument();
    expect(within(question('Checks')).getByRole('textbox', { name: 'Other' })).toBeInTheDocument();
    expect(within(form).getAllByRole('textbox')).toHaveLength(2);
    expect(within(form).queryByText(/add a note to the option/)).not.toBeInTheDocument();
  });

  it('sends a single-select\'s Other in place of its pick, and an option in place of Other, keeping the text unsent', async () => {
    const { user, question, submit } = ask(claude);
    const database = question('Database');
    const postgres = within(database).getByRole('radio', { name: 'Postgres' });
    const other = within(database).getByRole('radio', { name: 'Other' });
    const text = within(database).getByRole('textbox', { name: 'Other' });

    await user.click(postgres);
    await user.type(text, 'MySQL 8');
    expect(other).toBeChecked();
    expect(postgres).not.toBeChecked();
    expect(await submit()).toEqual({ question_0_custom: 'MySQL 8' });

    await user.click(within(database).getByRole('radio', { name: 'SQLite' }));
    expect(other).not.toBeChecked();
    expect(text).toHaveValue('MySQL 8');
    expect(await submit()).toEqual({ question_0: 'SQLite' });

    // Going back to the text chooses it again, and a tap on the chosen Other takes it back.
    await user.click(text);
    expect(other).toBeChecked();
    expect(await submit()).toEqual({ question_0_custom: 'MySQL 8' });
    await user.click(other);
    expect(other).not.toBeChecked();
    expect(await submit()).toEqual({});

    // Blank text chooses nothing.
    await user.clear(text);
    await user.type(text, '   ');
    expect(other).not.toBeChecked();
    expect(await submit()).toEqual({});
  });

  it('sends a multi-select\'s Other with its picks', async () => {
    const { user, question, submit } = ask(claude);
    const checks = question('Checks');
    await user.click(within(checks).getByRole('checkbox', { name: 'Lint' }));
    await user.click(within(checks).getByRole('checkbox', { name: 'Tests' }));
    const other = within(checks).getByRole('checkbox', { name: 'Other' });
    expect(other).not.toBeChecked();
    await user.type(within(checks).getByRole('textbox', { name: 'Other' }), 'Benchmarks');
    expect(other).toBeChecked();
    expect(await submit()).toEqual({ question_1: ['Tests', 'Lint'], question_1_custom: 'Benchmarks' });

    // Other alone, with no picks.
    await user.click(within(checks).getByRole('checkbox', { name: 'Lint' }));
    await user.click(within(checks).getByRole('checkbox', { name: 'Tests' }));
    expect(await submit()).toEqual({ question_1_custom: 'Benchmarks' });
  });

  it('sends Codex\'s note with the pick, which it requires', async () => {
    const { user, form, question, submit } = ask(codex, 'Codex needs your input to continue.');
    const deploy = question('Where should this deploy?');
    expect(within(deploy).getByText('The shared staging cluster')).toBeInTheDocument();
    expect(within(deploy).queryByRole('radio', { name: 'Additional answer or note' })).not.toBeInTheDocument();
    await user.type(within(deploy).getByRole('textbox', { name: 'Additional answer or note' }), 'after 5pm');
    expect(await submit()).toBeUndefined();
    expect(within(form).getByText('Where should this deploy? is required.')).toBeVisible();

    const none = within(deploy).getByRole('radio', { name: 'None of the above' });
    await user.click(none);
    await user.click(none);
    expect(none).toBeChecked();
    expect(await submit()).toEqual({ deploy_target: 'None of the above', deploy_target_note: 'after 5pm' });
  });

  it('keeps a field that follows no convention a field of its own', async () => {
    const { user, form, submit } = ask({
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        name_custom: { type: 'string', title: 'Other' },
        pick: { type: 'string', title: 'Pick', enum: ['a', 'b'] },
        pick_other: { type: 'string', title: 'Something else' },
      },
    }, 'Who?');
    expect(within(form).queryByRole('radio', { name: 'Other' })).not.toBeInTheDocument();
    expect(within(form).queryByRole('radio', { name: 'Something else' })).not.toBeInTheDocument();
    await user.click(within(form).getByRole('radio', { name: 'a' }));
    await user.type(within(form).getByRole('textbox', { name: 'Other' }), 'x');
    await user.type(within(form).getByRole('textbox', { name: 'Something else' }), 'y');
    expect(await submit()).toEqual({ name_custom: 'x', pick: 'a', pick_other: 'y' });
  });
});
