export const BROWSER_CONTROL_VERSION = 1 as const;
export const BROWSER_CONTROL_OPERATIONS = ['see', 'act'] as const;

export type BrowserControlOperation = typeof BROWSER_CONTROL_OPERATIONS[number];

export type BrowserAddress = {
  hostId: string;
  threadId: string;
  clientId: string;
  tabId: string;
};

export type BrowserControlLimits = {
  maxResultBytes: number;
  maxScreenshotBytes: number;
  maxElements: number;
  maxDurationMs: number;
};

export type BrowserControlAuthorization = {
  observe: boolean;
  control: boolean;
};

export type BrowserProviderOffer = {
  version: typeof BROWSER_CONTROL_VERSION;
  clientId: string;
  tabId: string;
  generation: number;
  controlRevision: number;
  platform: 'macOS' | 'iPadOS';
  operations: BrowserControlOperation[];
  authorization: BrowserControlAuthorization;
  limits: BrowserControlLimits;
};

export type BrowserProviderAttachParams = {
  threadId: string;
  offer: BrowserProviderOffer;
};

export type BrowserProviderLease = {
  leaseId: string;
  address: BrowserAddress;
  generation: number;
  controlRevision: number;
  expiresAt: string;
};

export type BrowserProviderDetachParams = { leaseId: string };

export type BrowserElement = {
  ref: string;
  role: string;
  name: string;
  disabled?: boolean;
  checked?: boolean;
};

export type BrowserScreenshotArtifact = {
  uri: string;
  sizeBytes: number;
  expiresAt: string;
};

export type BrowserScreenshot =
  | { mimeType: 'image/png'; data: string; artifact?: never }
  | { mimeType: 'image/png'; artifact: BrowserScreenshotArtifact; data?: never };

export type BrowserView = {
  id: string;
  tabId: string;
  generation: number;
  controlRevision: number;
  url: string;
  title?: string;
  loading: boolean;
  viewport: { width: number; height: number };
  text: string;
  elements: BrowserElement[];
  screenshot?: BrowserScreenshot;
  warnings: string[];
};

export type BrowserCondition =
  | { kind: 'text'; text: string }
  | { kind: 'url'; includes: string };

export type BrowserAction =
  | { kind: 'click'; target: string }
  | { kind: 'fill'; target: string; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: 'small' | 'page' };

export type BrowserControlCommand =
  | {
    kind: 'see';
    url?: string;
    screenshot?: boolean;
    wait?: BrowserCondition;
  }
  | {
    kind: 'act';
    viewId: string;
    action: BrowserAction;
    expect?: BrowserCondition;
    screenshot?: boolean;
  };

export type BrowserControlInvokeParams = {
  requestId: string;
  leaseId: string;
  address: BrowserAddress;
  generation: number;
  expectedControlRevision: number;
  deadlineAt: string;
  command: BrowserControlCommand;
};

export type BrowserControlInvokeResult = {
  requestId: string;
  leaseId: string;
  address: BrowserAddress;
  view: BrowserView;
};

export const BROWSER_CONTROL_ERROR_CODES = [
  'NOT_ATTACHED',
  'LEASE_REVOKED',
  'CONTROL_INTERRUPTED',
  'STALE_TAB',
  'STALE_VIEW',
  'UNSUPPORTED',
  'INVALID_TARGET',
  'TIMEOUT',
  'CANCELLED',
  'RESULT_TOO_LARGE',
  'NAVIGATION_FAILED',
  'HOST_DISCONNECTED',
  'BUSY',
] as const;

export type BrowserControlErrorCode = typeof BROWSER_CONTROL_ERROR_CODES[number];
export type BrowserControlErrorData = {
  domain: 'browser-control';
  code: BrowserControlErrorCode;
  retryable: boolean;
  view?: BrowserView;
};

const record = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, context: string) => {
  if (typeof value !== 'string' || !value) throw new Error(`${context} must be a non-empty string.`);
  return value;
};

const integer = (value: unknown, context: string, minimum = 0) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${context} is invalid.`);
  return Number(value);
};

const boolean = (value: unknown, context: string) => {
  if (typeof value !== 'boolean') throw new Error(`${context} must be a boolean.`);
  return value;
};

const optionalBoolean = (value: unknown, context: string) =>
  value === undefined ? undefined : boolean(value, context);

const condition = (value: unknown, context: string): BrowserCondition => {
  const input = record(value, context);
  if (input.kind === 'text') return { kind: 'text', text: text(input.text, `${context}.text`) };
  if (input.kind === 'url') return { kind: 'url', includes: text(input.includes, `${context}.includes`) };
  throw new Error(`${context}.kind is invalid.`);
};

const action = (value: unknown): BrowserAction => {
  const input = record(value, 'action');
  if (input.kind === 'click') return { kind: 'click', target: text(input.target, 'action.target') };
  if (input.kind === 'fill') {
    return { kind: 'fill', target: text(input.target, 'action.target'), text: text(input.text, 'action.text') };
  }
  if (input.kind === 'key') return { kind: 'key', key: text(input.key, 'action.key') };
  if (input.kind === 'scroll') {
    if (input.direction !== 'up' && input.direction !== 'down') throw new Error('action.direction is invalid.');
    if (input.amount !== undefined && input.amount !== 'small' && input.amount !== 'page') {
      throw new Error('action.amount is invalid.');
    }
    return {
      kind: 'scroll',
      direction: input.direction,
      ...(input.amount === undefined ? {} : { amount: input.amount }),
    };
  }
  throw new Error('action.kind is invalid.');
};

export const parseBrowserControlCommand = (value: unknown): BrowserControlCommand => {
  const input = record(value, 'browser control command');
  if (input.kind === 'see') {
    return {
      kind: 'see',
      ...(input.url === undefined ? {} : { url: text(input.url, 'url') }),
      ...(input.screenshot === undefined ? {} : { screenshot: boolean(input.screenshot, 'screenshot') }),
      ...(input.wait === undefined ? {} : { wait: condition(input.wait, 'wait') }),
    };
  }
  if (input.kind === 'act') {
    return {
      kind: 'act',
      viewId: text(input.viewId, 'viewId'),
      action: action(input.action),
      ...(input.expect === undefined ? {} : { expect: condition(input.expect, 'expect') }),
      ...(input.screenshot === undefined ? {} : { screenshot: boolean(input.screenshot, 'screenshot') }),
    };
  }
  throw new Error('browser control command kind is invalid.');
};

export const parseBrowserProviderOffer = (value: unknown): BrowserProviderOffer => {
  const input = record(value, 'browser provider offer');
  if (input.version !== BROWSER_CONTROL_VERSION) throw new Error('browser provider version is unsupported.');
  if (input.platform !== 'macOS' && input.platform !== 'iPadOS') throw new Error('browser provider platform is invalid.');
  if (!Array.isArray(input.operations)) throw new Error('browser provider operations must be an array.');
  const operations = input.operations.map((item, index) => {
    if (!BROWSER_CONTROL_OPERATIONS.includes(item as BrowserControlOperation)) {
      throw new Error(`browser provider operations[${index}] is invalid.`);
    }
    return item as BrowserControlOperation;
  });
  const limits = record(input.limits, 'browser provider limits');
  const authorization = record(input.authorization, 'browser provider authorization');
  return {
    version: BROWSER_CONTROL_VERSION,
    clientId: text(input.clientId, 'clientId'),
    tabId: text(input.tabId, 'tabId'),
    generation: integer(input.generation, 'generation', 1),
    controlRevision: integer(input.controlRevision, 'controlRevision'),
    platform: input.platform,
    operations: [...new Set(operations)],
    authorization: {
      observe: boolean(authorization.observe, 'authorization.observe'),
      control: boolean(authorization.control, 'authorization.control'),
    },
    limits: {
      maxResultBytes: integer(limits.maxResultBytes, 'limits.maxResultBytes', 1),
      maxScreenshotBytes: integer(limits.maxScreenshotBytes, 'limits.maxScreenshotBytes', 1),
      maxElements: integer(limits.maxElements, 'limits.maxElements', 1),
      maxDurationMs: integer(limits.maxDurationMs, 'limits.maxDurationMs', 1),
    },
  };
};

export const parseBrowserProviderAttachParams = (value: unknown): BrowserProviderAttachParams => {
  const input = record(value, 'browser provider attachment');
  return { threadId: text(input.threadId, 'threadId'), offer: parseBrowserProviderOffer(input.offer) };
};

export const parseBrowserProviderDetachParams = (value: unknown): BrowserProviderDetachParams => {
  const input = record(value, 'browser provider detachment');
  return { leaseId: text(input.leaseId, 'leaseId') };
};

const address = (value: unknown): BrowserAddress => {
  const input = record(value, 'browser address');
  return {
    hostId: text(input.hostId, 'address.hostId'),
    threadId: text(input.threadId, 'address.threadId'),
    clientId: text(input.clientId, 'address.clientId'),
    tabId: text(input.tabId, 'address.tabId'),
  };
};

export const parseBrowserProviderLease = (value: unknown): BrowserProviderLease => {
  const input = record(value, 'browser provider lease');
  const expiresAt = text(input.expiresAt, 'expiresAt');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('expiresAt is invalid.');
  return {
    leaseId: text(input.leaseId, 'leaseId'),
    address: address(input.address),
    generation: integer(input.generation, 'generation', 1),
    controlRevision: integer(input.controlRevision, 'controlRevision'),
    expiresAt,
  };
};

export const parseBrowserControlInvokeParams = (value: unknown): BrowserControlInvokeParams => {
  const input = record(value, 'browser control invocation');
  const deadlineAt = text(input.deadlineAt, 'deadlineAt');
  if (!Number.isFinite(Date.parse(deadlineAt))) throw new Error('deadlineAt is invalid.');
  return {
    requestId: text(input.requestId, 'requestId'),
    leaseId: text(input.leaseId, 'leaseId'),
    address: address(input.address),
    generation: integer(input.generation, 'generation', 1),
    expectedControlRevision: integer(input.expectedControlRevision, 'expectedControlRevision'),
    deadlineAt,
    command: parseBrowserControlCommand(input.command),
  };
};

const browserView = (value: unknown): BrowserView => {
  const input = record(value, 'browser view');
  const viewport = record(input.viewport, 'browser view viewport');
  if (!Array.isArray(input.elements) || !Array.isArray(input.warnings)) {
    throw new Error('browser view collections are invalid.');
  }
  const screenshot = input.screenshot === undefined ? undefined : record(input.screenshot, 'browser screenshot');
  if (screenshot && screenshot.mimeType !== 'image/png') throw new Error('browser screenshot type is invalid.');
  const screenshotArtifact = screenshot?.artifact === undefined
    ? undefined
    : record(screenshot.artifact, 'browser screenshot artifact');
  if (screenshot && (typeof screenshot.data === 'string') === Boolean(screenshotArtifact)) {
    throw new Error('browser screenshot must contain exactly one data or artifact payload.');
  }
  return {
    id: text(input.id, 'view.id'),
    tabId: text(input.tabId, 'view.tabId'),
    generation: integer(input.generation, 'view.generation', 1),
    controlRevision: integer(input.controlRevision, 'view.controlRevision'),
    url: text(input.url, 'view.url'),
    ...(input.title === undefined ? {} : { title: text(input.title, 'view.title') }),
    loading: boolean(input.loading, 'view.loading'),
    viewport: {
      width: integer(viewport.width, 'view.viewport.width'),
      height: integer(viewport.height, 'view.viewport.height'),
    },
    text: typeof input.text === 'string' ? input.text : (() => { throw new Error('view.text must be a string.'); })(),
    elements: input.elements.map((value, index) => {
      const element = record(value, `view.elements[${index}]`);
      return {
        ref: text(element.ref, `view.elements[${index}].ref`),
        role: text(element.role, `view.elements[${index}].role`),
        name: typeof element.name === 'string' ? element.name : (() => { throw new Error(`view.elements[${index}].name must be a string.`); })(),
        ...(element.disabled === undefined ? {} : { disabled: boolean(element.disabled, `view.elements[${index}].disabled`) }),
        ...(element.checked === undefined ? {} : { checked: boolean(element.checked, `view.elements[${index}].checked`) }),
      };
    }),
    ...(screenshot
      ? {
        screenshot: screenshotArtifact
          ? {
            mimeType: 'image/png' as const,
            artifact: {
              uri: text(screenshotArtifact.uri, 'screenshot.artifact.uri'),
              sizeBytes: integer(screenshotArtifact.sizeBytes, 'screenshot.artifact.sizeBytes', 1),
              expiresAt: (() => {
                const expiresAt = text(screenshotArtifact.expiresAt, 'screenshot.artifact.expiresAt');
                if (!Number.isFinite(Date.parse(expiresAt))) {
                  throw new Error('screenshot.artifact.expiresAt is invalid.');
                }
                return expiresAt;
              })(),
            },
          }
          : { mimeType: 'image/png' as const, data: text(screenshot.data, 'screenshot.data') },
      }
      : {}),
    warnings: input.warnings.map((warning, index) => text(warning, `view.warnings[${index}]`)),
  };
};

export const parseBrowserControlInvokeResult = (value: unknown): BrowserControlInvokeResult => {
  const input = record(value, 'browser control result');
  return {
    requestId: text(input.requestId, 'requestId'),
    leaseId: text(input.leaseId, 'leaseId'),
    address: address(input.address),
    view: browserView(input.view),
  };
};

export const parseBrowserControlErrorData = (value: unknown): BrowserControlErrorData => {
  const input = record(value, 'browser control error');
  if (input.domain !== 'browser-control') throw new Error('browser control error domain is invalid.');
  if (!BROWSER_CONTROL_ERROR_CODES.includes(input.code as BrowserControlErrorCode)) {
    throw new Error('browser control error code is invalid.');
  }
  return {
    domain: 'browser-control',
    code: input.code as BrowserControlErrorCode,
    retryable: boolean(input.retryable, 'retryable'),
  };
};
