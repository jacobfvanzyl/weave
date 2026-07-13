import { describe, expect, it } from 'vitest';
import { portalStatusPresentation } from '../src/renderer/portal-status';

describe('PortalStatusIndicator', () => {
  it.each([
    [{ phase: 'starting', serverUrl: 'http://homelab:4111' } as const, 'Starting Portal', false],
    [{ phase: 'ready', serverUrl: 'http://homelab:4111', source: 'adopted' } as const, 'Portal ready · adopted', false],
    [{ phase: 'reconnecting', serverUrl: 'http://homelab:4111' } as const, 'Portal reconnecting', false],
    [{ phase: 'failed', serverUrl: 'http://homelab:4111', error: 'launch failed' } as const, 'Portal failed', true],
  ])('renders %s as %s with Retry=%s', (status, label, showRetry) => {
    expect(portalStatusPresentation(status)).toMatchObject({ label, showRetry });
  });
});
