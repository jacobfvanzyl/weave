import type { DocSnapshot } from '@blocksuite/store';
import {
  coppermindBlockSuitePackageVersion,
  createCoppermindBlockSuiteRuntime,
  disposeCoppermindBlockSuiteRuntime,
  exportCoppermindBlockSuiteSnapshot,
} from './coppermind-blocksuite';

export const coppermindDocumentExtension = '.cpr';
export const coppermindDocumentKind = 'coppermind.document';
export const coppermindDocumentVersion = 2;
export const legacyCoppermindDocumentVersion = 1;

export type CoppermindDocMode = 'page' | 'edgeless';

export type CoppermindDocumentMetadata = {
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type CoppermindBlockSuitePayload = {
  format: 'snapshot';
  packageVersion: typeof coppermindBlockSuitePackageVersion;
  docId: string;
  snapshot: DocSnapshot;
};

export type CoppermindDocument = {
  kind: typeof coppermindDocumentKind;
  version: typeof coppermindDocumentVersion;
  metadata: CoppermindDocumentMetadata;
  blocksuite: CoppermindBlockSuitePayload;
  ui: {
    lastMode: CoppermindDocMode;
  };
};

export type LegacyCoppermindCanvasPlacement =
  | { state: 'unplaced' }
  | { state: 'placed'; xywh: [x: number, y: number, w: number, h: number] };

export type LegacyCoppermindBlock = {
  id: string;
  flavor: string;
  displayMode: 'doc-and-edgeless' | 'doc-only' | 'edgeless-only';
  children: string[];
  text?: string;
  canvasPlacement: LegacyCoppermindCanvasPlacement;
};

export type LegacyCoppermindDocument = {
  kind: typeof coppermindDocumentKind;
  version: typeof legacyCoppermindDocumentVersion;
  metadata: CoppermindDocumentMetadata;
  modes: {
    primary: CoppermindDocMode;
    available: ['page', 'edgeless'];
  };
  root: {
    id: string;
    flavor: 'coppermind:page';
    surfaceId: string;
    children: string[];
  };
  surface: {
    id: string;
    frames: Array<{
      id: string;
      title?: string;
      xywh: [x: number, y: number, w: number, h: number];
      elementIds: string[];
    }>;
    elements: unknown[];
  };
  blocks: LegacyCoppermindBlock[];
  inlineSurfaceRegions: Array<{
    id: string;
    blockId: string;
    frameId: string;
    caption?: string;
    preferredSize: { width: number; height: number };
    collapsed: boolean;
  }>;
};

export type ParsedCoppermindDocument = CoppermindDocument | LegacyCoppermindDocument;

export type CreateCoppermindDocumentOptions = {
  now?: Date;
  path?: string;
  title?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const slugId = (value: string) => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'untitled';

const getBasename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

const getTimestamp = (now?: Date) => (now ?? new Date()).toISOString();

const isDocSnapshot = (value: unknown): value is DocSnapshot => (
  isRecord(value)
  && value.type === 'page'
  && isRecord(value.meta)
  && isRecord(value.blocks)
);

const getTitle = (options: CreateCoppermindDocumentOptions = {}) => (
  options.title?.trim()
  || (options.path ? getCoppermindDocumentDisplayName(options.path) : '')
  || 'Untitled'
);

const getLegacyParagraphTexts = (document: LegacyCoppermindDocument) => (
  document.blocks
    .filter(block => block.displayMode !== 'edgeless-only')
    .map(block => block.text?.trim() ?? '')
    .filter(Boolean)
);

const createDocumentFromSnapshot = (options: {
  docId: string;
  lastMode?: CoppermindDocMode;
  metadata: CoppermindDocumentMetadata;
  snapshot: DocSnapshot;
}): CoppermindDocument => ({
  kind: coppermindDocumentKind,
  version: coppermindDocumentVersion,
  metadata: options.metadata,
  blocksuite: {
    format: 'snapshot',
    packageVersion: coppermindBlockSuitePackageVersion,
    docId: options.docId,
    snapshot: options.snapshot,
  },
  ui: {
    lastMode: options.lastMode ?? 'page',
  },
});

export const isCoppermindDocumentPath = (path: string | undefined) => (
  Boolean(path && /\.cpr$/i.test(path))
);

export const normalizeCoppermindDocumentPath = (value: string) => (
  /\.cpr$/i.test(value) ? value : `${value}${coppermindDocumentExtension}`
);

export const getCoppermindDocumentDisplayName = (path: string) => (
  getBasename(path).replace(/\.cpr$/i, '')
);

export const isCoppermindDocumentV2 = (document: ParsedCoppermindDocument | undefined): document is CoppermindDocument => (
  Boolean(document && document.version === coppermindDocumentVersion)
);

export const isLegacyCoppermindDocument = (document: ParsedCoppermindDocument | undefined): document is LegacyCoppermindDocument => (
  Boolean(document && document.version === legacyCoppermindDocumentVersion)
);

export const createEmptyCoppermindDocument = (options: CreateCoppermindDocumentOptions = {}): CoppermindDocument => {
  const title = getTitle(options);
  const now = options.now ?? new Date();
  const timestamp = getTimestamp(now);
  const docId = `doc:${slugId(title)}`;
  const runtime = createCoppermindBlockSuiteRuntime({
    docId,
    now,
    title,
  });

  try {
    return createDocumentFromSnapshot({
      docId,
      metadata: {
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      snapshot: exportCoppermindBlockSuiteSnapshot(runtime, { now, title }),
    });
  } finally {
    disposeCoppermindBlockSuiteRuntime(runtime);
  }
};

export const migrateCoppermindDocumentToV2 = (
  document: LegacyCoppermindDocument,
  options: { now?: Date } = {},
): CoppermindDocument => {
  const now = options.now ?? new Date(document.metadata.updatedAt || document.metadata.createdAt);
  const docId = `doc:${slugId(document.metadata.title || document.root.id)}`;
  const runtime = createCoppermindBlockSuiteRuntime({
    docId,
    now,
    paragraphTexts: getLegacyParagraphTexts(document),
    title: document.metadata.title || 'Untitled',
  });

  try {
    return createDocumentFromSnapshot({
      docId,
      lastMode: document.modes.primary,
      metadata: {
        ...document.metadata,
        updatedAt: getTimestamp(now),
      },
      snapshot: exportCoppermindBlockSuiteSnapshot(runtime, {
        now,
        title: document.metadata.title || 'Untitled',
      }),
    });
  } finally {
    disposeCoppermindBlockSuiteRuntime(runtime);
  }
};

export const withCoppermindDocumentSnapshot = (
  document: CoppermindDocument,
  snapshot: DocSnapshot,
  options: { lastMode?: CoppermindDocMode; now?: Date } = {},
): CoppermindDocument => ({
  ...document,
  metadata: {
    ...document.metadata,
    updatedAt: getTimestamp(options.now),
  },
  blocksuite: {
    ...document.blocksuite,
    snapshot,
  },
  ui: {
    ...document.ui,
    lastMode: options.lastMode ?? document.ui.lastMode,
  },
});

export const serializeCoppermindDocument = (document: CoppermindDocument) => (
  `${JSON.stringify(document, null, 2)}\n`
);

export const createEmptyCoppermindDocumentContent = (options: CreateCoppermindDocumentOptions = {}) => (
  serializeCoppermindDocument(createEmptyCoppermindDocument(options))
);

export const parseCoppermindDocument = (content: string): ParsedCoppermindDocument | undefined => {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.kind !== coppermindDocumentKind) return undefined;

    if (parsed.version === coppermindDocumentVersion) {
      const blocksuite = isRecord(parsed.blocksuite) ? parsed.blocksuite : undefined;
      if (!blocksuite || blocksuite.format !== 'snapshot') return undefined;
      if (blocksuite.packageVersion !== coppermindBlockSuitePackageVersion) return undefined;
      if (typeof blocksuite.docId !== 'string' || !blocksuite.docId) return undefined;
      if (!isDocSnapshot(blocksuite.snapshot)) return undefined;
      return parsed as CoppermindDocument;
    }

    if (parsed.version === legacyCoppermindDocumentVersion) {
      if (!isRecord(parsed.metadata) || !Array.isArray(parsed.blocks) || !isRecord(parsed.root)) return undefined;
      return parsed as LegacyCoppermindDocument;
    }

    return undefined;
  } catch {
    return undefined;
  }
};

