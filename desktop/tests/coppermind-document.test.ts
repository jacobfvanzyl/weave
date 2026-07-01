import { describe, expect, it } from 'vitest';
import type { DocSnapshot } from '@blocksuite/store';
import {
  coppermindBlockSuitePackageVersion,
  addCoppermindBlockSuiteSection,
  createCoppermindBlockSuiteRuntime,
  deleteCoppermindBlockSuiteSection,
  disposeCoppermindBlockSuiteRuntime,
  getCoppermindBlockSuiteSections,
} from '../../packages/client/src/lib/coppermind-blocksuite';
import {
  createEmptyCoppermindDocument,
  createEmptyCoppermindDocumentContent,
  isCoppermindDocumentV2,
  isLegacyCoppermindDocument,
  migrateCoppermindDocumentToV2,
  parseCoppermindDocument,
  type LegacyCoppermindDocument,
} from '../../packages/client/src/lib/coppermind-document';

type SnapshotBlock = DocSnapshot['blocks'];

const findSnapshotBlock = (
  block: SnapshotBlock | undefined,
  flavour: string,
): SnapshotBlock | undefined => {
  if (!block) return undefined;
  if (block.flavour === flavour) return block;
  for (const child of block.children ?? []) {
    const match = findSnapshotBlock(child, flavour);
    if (match) return match;
  }
  return undefined;
};

const getSnapshotText = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || !('delta' in value)) return '';
  const delta = (value as { delta?: unknown }).delta;
  if (!Array.isArray(delta)) return '';
  return delta
    .map(operation => (
      operation && typeof operation === 'object' && 'insert' in operation
        ? String((operation as { insert?: unknown }).insert ?? '')
        : ''
    ))
    .join('');
};

const legacyDocument = (): LegacyCoppermindDocument => ({
  kind: 'coppermind.document',
  version: 1,
  metadata: {
    title: 'Research Notebook',
    createdAt: '2026-06-30T10:00:00.000Z',
    updatedAt: '2026-06-30T10:00:00.000Z',
  },
  modes: { primary: 'edgeless', available: ['page', 'edgeless'] },
  root: {
    id: 'page:research-notebook',
    flavor: 'coppermind:page',
    surfaceId: 'surface:research-notebook',
    children: ['note:research-notebook'],
  },
  surface: { id: 'surface:research-notebook', frames: [], elements: [] },
  blocks: [
    {
      id: 'note:research-notebook',
      flavor: 'coppermind:note',
      displayMode: 'doc-and-edgeless',
      children: ['paragraph:research-notebook'],
      canvasPlacement: { state: 'unplaced' },
    },
    {
      id: 'paragraph:research-notebook',
      flavor: 'coppermind:paragraph',
      displayMode: 'doc-and-edgeless',
      children: [],
      text: 'A note body',
      canvasPlacement: { state: 'unplaced' },
    },
  ],
  inlineSurfaceRegions: [],
});

describe('Coppermind .cpr document structure', () => {
  it('creates new documents as v2 BlockSuite snapshots', () => {
    const document = createEmptyCoppermindDocument({
      now: new Date('2026-06-30T10:00:00.000Z'),
      path: 'Research.cpr',
    });

    expect(document.kind).toBe('coppermind.document');
    expect(document.version).toBe(2);
    expect(document.metadata).toEqual({
      title: 'Research',
      createdAt: '2026-06-30T10:00:00.000Z',
      updatedAt: '2026-06-30T10:00:00.000Z',
    });
    expect(document.ui.lastMode).toBe('page');
    expect(document.blocksuite).toMatchObject({
      format: 'snapshot',
      packageVersion: coppermindBlockSuitePackageVersion,
      docId: 'doc:research',
    });
  });

  it('initializes BlockSuite with page, surface, note, and paragraph blocks', () => {
    const document = createEmptyCoppermindDocument({
      now: new Date('2026-06-30T10:00:00.000Z'),
      title: 'Notebook',
    });
    const root = document.blocksuite.snapshot.blocks;

    expect(root.flavour).toBe('affine:page');
    expect(findSnapshotBlock(root, 'affine:surface')).toBeTruthy();
    expect(findSnapshotBlock(root, 'affine:note')).toBeTruthy();
    expect(findSnapshotBlock(root, 'affine:paragraph')).toBeTruthy();
  });

  it('serializes and parses the v2 JSON .cpr envelope', () => {
    const content = createEmptyCoppermindDocumentContent({
      now: new Date('2026-06-30T10:00:00.000Z'),
      title: 'Notebook',
    });

    const parsed = parseCoppermindDocument(content);

    expect(isCoppermindDocumentV2(parsed)).toBe(true);
    if (!isCoppermindDocumentV2(parsed)) throw new Error('expected v2 document');
    expect(parsed.metadata.title).toBe('Notebook');
    expect(parsed.blocksuite.snapshot.type).toBe('page');
    expect(parseCoppermindDocument('{"kind":"wrong"}')).toBeUndefined();
  });

  it('parses legacy v1 documents and migrates their text into BlockSuite paragraphs', () => {
    const legacy = legacyDocument();
    const parsed = parseCoppermindDocument(JSON.stringify(legacy));

    expect(isLegacyCoppermindDocument(parsed)).toBe(true);
    if (!isLegacyCoppermindDocument(parsed)) throw new Error('expected legacy document');

    const migrated = migrateCoppermindDocumentToV2(parsed, {
      now: new Date('2026-06-30T10:05:00.000Z'),
    });
    const paragraph = findSnapshotBlock(migrated.blocksuite.snapshot.blocks, 'affine:paragraph');

    expect(migrated.version).toBe(2);
    expect(migrated.ui.lastMode).toBe('edgeless');
    expect(migrated.metadata.updatedAt).toBe('2026-06-30T10:05:00.000Z');
    expect(getSnapshotText(paragraph?.props.text)).toBe('A note body');
  });

  it('treats BlockSuite notes as Coppermind page sections', () => {
    const runtime = createCoppermindBlockSuiteRuntime({
      docId: 'doc:notebook',
      now: new Date('2026-06-30T10:00:00.000Z'),
      paragraphTexts: ['First section'],
      title: 'Notebook',
    });

    try {
      expect(getCoppermindBlockSuiteSections(runtime.doc)).toMatchObject([
        {
          childCount: 1,
          isEmpty: false,
          title: 'First section',
        },
      ]);

      const secondSectionId = addCoppermindBlockSuiteSection(runtime.doc);
      const sections = getCoppermindBlockSuiteSections(runtime.doc);
      const firstNote = runtime.doc.getBlockById(sections[0].id) as { xywh?: string } | null;
      const secondNote = runtime.doc.getBlockById(secondSectionId) as { xywh?: string } | null;

      expect(sections).toHaveLength(2);
      expect(sections[1]).toMatchObject({
        childCount: 1,
        id: secondSectionId,
        isEmpty: true,
        title: 'Untitled section 2',
      });
      expect(JSON.parse(secondNote?.xywh ?? '[]')[0]).toBeGreaterThan(JSON.parse(firstNote?.xywh ?? '[]')[0]);

      expect(deleteCoppermindBlockSuiteSection(runtime.doc, secondSectionId)).toBe(true);
      expect(getCoppermindBlockSuiteSections(runtime.doc)).toHaveLength(1);
    } finally {
      disposeCoppermindBlockSuiteRuntime(runtime);
    }
  });
});
