import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaneContentHost } from '../../packages/client/src/components/panes/PaneContentHost';

describe('Pane content hosts', () => {
  it('renders a composition-owned content surface without legacy layout state', () => {
    const markup = renderToStaticMarkup(
      <PaneContentHost
        identity={{ paneId: 'pane-1', workspaceId: 'workspace-1' }}
        paneType="thread"
      >
        <textarea defaultValue="draft" />
      </PaneContentHost>,
    );

    expect(markup).toContain('data-weave-pane-host="thread"');
    expect(markup).toContain('data-weave-pane-id="pane-1"');
    expect(markup).toContain('data-weave-workspace-id="workspace-1"');
    expect(markup).toContain('<textarea>draft</textarea>');
    expect(markup).not.toContain('data-weave-main-pane');
  });

});
