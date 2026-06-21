export type ApplePencilInteractionPhase = 'began' | 'changed' | 'ended' | 'cancelled' | 'unknown';

export type ApplePencilPreferredAction =
  | 'ignore'
  | 'switchEraser'
  | 'switchPrevious'
  | 'showColorPalette'
  | 'showInkAttributes'
  | 'showContextualPalette'
  | 'runSystemShortcut'
  | 'unknown';

export type ApplePencilHoverPose = {
  x: number;
  y: number;
  zOffset: number;
  altitudeAngle: number;
  azimuthAngle: number;
  azimuthUnitVector: {
    dx: number;
    dy: number;
  };
  rollAngle: number;
};

export type ApplePencilSqueezeEvent = {
  phase: ApplePencilInteractionPhase;
  preferredAction: ApplePencilPreferredAction;
  timestamp: number;
  hoverPose?: ApplePencilHoverPose;
  isDoubleSqueeze?: boolean;
};

export type ApplePencilTapEvent = {
  preferredAction: ApplePencilPreferredAction;
  timestamp: number;
  hoverPose?: ApplePencilHoverPose;
};

export type ApplePencilPaletteEvent = {
  visible: boolean;
};

type ApplePencilEventMap = {
  palette: ApplePencilPaletteEvent;
  squeeze: ApplePencilSqueezeEvent;
  tap: ApplePencilTapEvent;
};

type ApplePencilEventName = keyof ApplePencilEventMap;
type ApplePencilListener<EventName extends ApplePencilEventName> = (event: ApplePencilEventMap[EventName]) => void;

const eventNames: Record<ApplePencilEventName, string> = {
  palette: 'weave:apple-pencil:palette',
  squeeze: 'weave:apple-pencil:squeeze',
  tap: 'weave:apple-pencil:tap',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

const isHoverPose = (value: unknown): value is ApplePencilHoverPose => {
  if (!isRecord(value)) return false;
  if (!isNumber(value.x) || !isNumber(value.y)) return false;
  if (!isNumber(value.zOffset) || !isNumber(value.altitudeAngle)) return false;
  if (!isNumber(value.azimuthAngle) || !isNumber(value.rollAngle)) return false;
  if (!isRecord(value.azimuthUnitVector)) return false;
  return isNumber(value.azimuthUnitVector.dx) && isNumber(value.azimuthUnitVector.dy);
};

const normalizePreferredAction = (value: unknown): ApplePencilPreferredAction => {
  switch (value) {
    case 'ignore':
    case 'switchEraser':
    case 'switchPrevious':
    case 'showColorPalette':
    case 'showInkAttributes':
    case 'showContextualPalette':
    case 'runSystemShortcut':
      return value;
    default:
      return 'unknown';
  }
};

const normalizePhase = (value: unknown): ApplePencilInteractionPhase => {
  switch (value) {
    case 'began':
    case 'changed':
    case 'ended':
    case 'cancelled':
      return value;
    default:
      return 'unknown';
  }
};

const parseSqueezeEvent = (value: unknown): ApplePencilSqueezeEvent | null => {
  if (!isRecord(value) || !isNumber(value.timestamp)) return null;
  const hoverPose = isHoverPose(value.hoverPose) ? value.hoverPose : undefined;

  return {
    phase: normalizePhase(value.phase),
    preferredAction: normalizePreferredAction(value.preferredAction),
    timestamp: value.timestamp,
    ...(hoverPose ? { hoverPose } : {}),
    ...(isBoolean(value.isDoubleSqueeze) ? { isDoubleSqueeze: value.isDoubleSqueeze } : {}),
  };
};

const parseTapEvent = (value: unknown): ApplePencilTapEvent | null => {
  if (!isRecord(value) || !isNumber(value.timestamp)) return null;
  const hoverPose = isHoverPose(value.hoverPose) ? value.hoverPose : undefined;

  return {
    preferredAction: normalizePreferredAction(value.preferredAction),
    timestamp: value.timestamp,
    ...(hoverPose ? { hoverPose } : {}),
  };
};

const parsePaletteEvent = (value: unknown): ApplePencilPaletteEvent | null => {
  if (!isRecord(value) || !isBoolean(value.visible)) return null;

  return {
    visible: value.visible,
  };
};

const parseEvent = <EventName extends ApplePencilEventName>(
  name: EventName,
  value: unknown,
): ApplePencilEventMap[EventName] | null => {
  switch (name) {
    case 'palette':
      return parsePaletteEvent(value) as ApplePencilEventMap[EventName] | null;
    case 'squeeze':
      return parseSqueezeEvent(value) as ApplePencilEventMap[EventName] | null;
    case 'tap':
      return parseTapEvent(value) as ApplePencilEventMap[EventName] | null;
  }
  return null;
};

export const subscribeApplePencilEvent = <EventName extends ApplePencilEventName>(
  name: EventName,
  listener: ApplePencilListener<EventName>,
) => {
  if (typeof window === 'undefined') return () => {};

  const handleEvent = (event: Event) => {
    const parsed = parseEvent(name, event instanceof CustomEvent ? event.detail : undefined);
    if (parsed) listener(parsed);
  };

  window.addEventListener(eventNames[name], handleEvent);
  return () => window.removeEventListener(eventNames[name], handleEvent);
};

export const subscribeApplePencilSqueeze = (listener: ApplePencilListener<'squeeze'>) =>
  subscribeApplePencilEvent('squeeze', listener);

export const subscribeApplePencilTap = (listener: ApplePencilListener<'tap'>) =>
  subscribeApplePencilEvent('tap', listener);

export const subscribeApplePencilPalette = (listener: ApplePencilListener<'palette'>) =>
  subscribeApplePencilEvent('palette', listener);
