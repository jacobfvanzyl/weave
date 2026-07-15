type PortalPresence = {
  portalId: string;
  status: 'online' | 'offline';
};

export const portalCountPresentation = (
  portals: PortalPresence[],
  adoptedLocalPortalId?: string,
) => {
  const onlinePortals = portals.filter(portal => portal.status === 'online');
  const includesAdoptedLocalPortal = Boolean(
    adoptedLocalPortalId
    && onlinePortals.some(portal => portal.portalId === adoptedLocalPortalId),
  );
  const count = onlinePortals.length;
  const countLabel = `${count} online Portal${count === 1 ? '' : 's'}`;

  return {
    count,
    includesAdoptedLocalPortal,
    label: includesAdoptedLocalPortal
      ? `${countLabel} · includes Desktop-adopted local Portal`
      : countLabel,
    tone: count === 0
      ? 'text-muted-foreground'
      : includesAdoptedLocalPortal
        ? 'text-mauve'
        : 'text-success',
  };
};
