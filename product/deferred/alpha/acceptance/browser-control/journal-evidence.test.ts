import { describe, expect, it } from 'bun:test';
import { collectBrowserControlEvidence } from './journal-evidence';

const update = (sequence: number, tool: string, args: unknown, view: Record<string, unknown>, screenshot = false) => ({
  threadId: 'thread-1',
  sequence,
  message: { params: { update: {
    sessionUpdate: 'tool_call_update',
    status: 'completed',
    rawInput: { tool, arguments: args },
    rawOutput: { result: {
      structuredContent: view,
      content: [
        { type: 'text', text: JSON.stringify(view) },
        ...(screenshot ? [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(400) }] : []),
      ],
    } },
  } } },
});

const failedNavigation = (sequence: number, url: string) => ({
  threadId: 'thread-1',
  sequence,
  message: { params: { update: {
    sessionUpdate: 'tool_call_update',
    status: 'failed',
    rawInput: { tool: 'browser_see', arguments: { url } },
    rawOutput: { result: { structuredContent: {
      error: { code: 'TIMEOUT', message: 'Browser navigation timed out.', retryable: false },
    } } },
  } } },
});

describe('Browser control journal evidence', () => {
  it('requires HTTPS, a fresh action chain, the complete core task, and screenshot evidence', () => {
    const base = { tabId: 'tab-1', generation: 2, controlRevision: 3, url: 'https://fixture.test/', text: 'ready' };
    const events = [
      update(1, 'browser_see', { url: 'https://fixture.test/' }, { ...base, id: 'view-1' }),
      update(2, 'browser_act', { viewId: 'view-1', action: { kind: 'fill' } }, { ...base, id: 'view-2' }),
      update(3, 'browser_act', { viewId: 'view-2', action: { kind: 'key' } }, { ...base, id: 'view-3' }),
      update(4, 'browser_act', { viewId: 'view-3', action: { kind: 'click' } }, { ...base, id: 'view-4' }),
      update(5, 'browser_act', { viewId: 'view-4', action: { kind: 'scroll' } }, {
        ...base, id: 'view-5', text: 'control:applied:WVE-60:key:K',
      }, true),
    ];
    expect(collectBrowserControlEvidence(events, {
      threadId: 'thread-1',
      platform: 'macOS',
      expectedText: 'control:applied:WVE-60:key:K',
    })).toMatchObject({
      platform: 'macOS',
      tabId: 'tab-1',
      generation: 2,
      controlRevision: 3,
      navigationOutcome: 'completed',
      freshViewChain: true,
      screenshot: { kind: 'inline', sizeBytes: 300 },
    });
  });

  it('retains a timed-out navigation only when a later fresh observation proves the requested URL loaded', () => {
    const base = { tabId: 'tab-1', generation: 2, controlRevision: 3, url: 'https://fixture.test/', text: 'ready' };
    const events = [
      failedNavigation(1, 'https://fixture.test/'),
      update(2, 'browser_see', {}, { ...base, id: 'view-1' }),
      update(3, 'browser_act', { viewId: 'view-1', action: { kind: 'fill' } }, { ...base, id: 'view-2' }),
      update(4, 'browser_act', { viewId: 'view-2', action: { kind: 'key' } }, { ...base, id: 'view-3' }),
      update(5, 'browser_act', { viewId: 'view-3', action: { kind: 'click' } }, { ...base, id: 'view-4' }),
      update(6, 'browser_act', { viewId: 'view-4', action: { kind: 'scroll' } }, {
        ...base, id: 'view-5', text: 'control:applied:WVE-60:key:K',
      }, true),
    ];
    expect(collectBrowserControlEvidence(events, {
      threadId: 'thread-1',
      platform: 'macOS',
      expectedText: 'control:applied:WVE-60:key:K',
    })).toMatchObject({
      navigationOutcome: 'timed-out-then-observed',
      actions: ['navigate', 'observe', 'fill', 'key', 'click', 'scroll'],
      typedFailures: ['TIMEOUT'],
    });
  });
});
