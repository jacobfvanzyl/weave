import { describe, expect, it } from 'vitest';
import { portalCountPresentation } from './portal-count-presentation';

describe('portalCountPresentation', () => {
  it.each([
    {
      name: 'no online Portals',
      portals: [],
      adoptedLocalPortalId: undefined,
      expected: { count: 0, includesAdoptedLocalPortal: false, tone: 'text-muted-foreground' },
    },
    {
      name: 'a remote Portal',
      portals: [{ portalId: 'remote', status: 'online' }] as const,
      adoptedLocalPortalId: undefined,
      expected: { count: 1, includesAdoptedLocalPortal: false, tone: 'text-success' },
    },
    {
      name: 'an adopted local Portal',
      portals: [{ portalId: 'local', status: 'online' }] as const,
      adoptedLocalPortalId: 'local',
      expected: { count: 1, includesAdoptedLocalPortal: true, tone: 'text-mauve' },
    },
    {
      name: 'mixed adopted local and remote Portals',
      portals: [
        { portalId: 'local', status: 'online' },
        { portalId: 'remote', status: 'online' },
      ] as const,
      adoptedLocalPortalId: 'local',
      expected: { count: 2, includesAdoptedLocalPortal: true, tone: 'text-mauve' },
    },
    {
      name: 'a stale adopted Portal identity with a remote Portal online',
      portals: [
        { portalId: 'local', status: 'offline' },
        { portalId: 'remote', status: 'online' },
      ] as const,
      adoptedLocalPortalId: 'local',
      expected: { count: 1, includesAdoptedLocalPortal: false, tone: 'text-success' },
    },
  ])('presents $name', ({ portals, adoptedLocalPortalId, expected }) => {
    expect(portalCountPresentation([...portals], adoptedLocalPortalId)).toMatchObject(expected);
  });

  it('adds adopted-local context to the accessible label', () => {
    expect(portalCountPresentation(
      [{ portalId: 'local', status: 'online' }],
      'local',
    ).label).toBe('1 online Portal · includes Desktop-adopted local Portal');
  });
});
