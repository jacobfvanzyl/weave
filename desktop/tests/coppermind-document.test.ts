import { describe, expect, it } from 'vitest';
import { Text, type Doc, type DocSnapshot } from '@blocksuite/store';
import {
  coppermindBlockSuitePackageVersion,
  coppermindCanvasCellGapPx,
  coppermindCellWidthPx,
  addCoppermindBlockSuiteSection,
  addCoppermindBlockSuiteInkSection,
  createCoppermindNextCanvasCellXYWH,
  createCoppermindSectionXYWHAtCenter,
  createCoppermindBlockSuiteRuntime,
  deleteCoppermindBlockSuiteSection,
  disposeCoppermindBlockSuiteRuntime,
  exportCoppermindBlockSuiteSnapshot,
  getCoppermindBlockSuiteSections,
  importCoppermindBlockSuiteRuntime,
  placeCoppermindBlockSuiteSection,
  reorderCoppermindBlockSuiteSection,
  setCoppermindInkCellHeightMode,
  setCoppermindInkCellStackState,
  unplaceCoppermindBlockSuiteSection,
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
import {
  coppermindInkCellFlavour,
  getCoppermindInkContentHeight,
  normalizeCoppermindInkBackground,
  type CoppermindInkBackground,
  type CoppermindInkStroke,
} from '../../packages/client/src/lib/coppermind-ink-cell';
import {
  coppermindA4PageHeightPx,
  coppermindCanvasDefaultCellHeightPx,
  coppermindInkCellMinHeightPx,
  coppermindInkContentPaddingPx,
} from '../../packages/client/src/lib/coppermind-layout';

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

const findSnapshotBlocks = (
  block: SnapshotBlock | undefined,
  flavour: string,
): SnapshotBlock[] => {
  if (!block) return [];
  return [
    ...(block.flavour === flavour ? [block] : []),
    ...(block.children ?? []).flatMap(child => findSnapshotBlocks(child, flavour)),
  ];
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

const setSectionText = (doc: Doc, sectionId: string, text: string) => {
  const section = doc.getBlockById(sectionId);
  const paragraph = section?.children[0];
  if (!paragraph) throw new Error(`expected section ${sectionId} to have a paragraph`);
  doc.updateBlock(paragraph, { text: new Text(text) });
};

const setInkStrokeData = (doc: Doc, sectionId: string, strokes: CoppermindInkStroke[]) => {
  const section = doc.getBlockById(sectionId);
  const inkCell = section?.children.find(child => child.flavour === coppermindInkCellFlavour);
  if (!inkCell) throw new Error(`expected section ${sectionId} to have an ink cell`);
  doc.updateBlock(inkCell, {
    strokeData: JSON.stringify({ strokes, version: 1 }),
  });
};

const setInkBackground = (doc: Doc, sectionId: string, background: CoppermindInkBackground) => {
  const section = doc.getBlockById(sectionId);
  const inkCell = section?.children.find(child => child.flavour === coppermindInkCellFlavour);
  if (!inkCell) throw new Error(`expected section ${sectionId} to have an ink cell`);
  doc.updateBlock(inkCell, { background });
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
    const note = findSnapshotBlock(root, 'affine:note');
    expect(note).toBeTruthy();
    expect((note?.props as { displayMode?: unknown } | undefined)?.displayMode).toBe('doc');
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
          placement: { state: 'unplaced' },
          title: 'First section',
        },
      ]);

      const secondSectionId = addCoppermindBlockSuiteSection(runtime.doc);
      const sections = getCoppermindBlockSuiteSections(runtime.doc);

      expect(sections).toHaveLength(2);
      expect(sections[1]).toMatchObject({
        childCount: 1,
        id: secondSectionId,
        isEmpty: true,
        placement: { state: 'unplaced' },
        title: 'Untitled cell 2',
      });

      expect(deleteCoppermindBlockSuiteSection(runtime.doc, secondSectionId)).toBe(true);
      expect(getCoppermindBlockSuiteSections(runtime.doc)).toHaveLength(1);
    } finally {
      disposeCoppermindBlockSuiteRuntime(runtime);
    }
  });

  it('stores ink cells as versioned vector data and round-trips BlockSuite snapshots', async () => {
    const runtime = createCoppermindBlockSuiteRuntime({
      docId: 'doc:notebook',
      now: new Date('2026-06-30T10:00:00.000Z'),
      paragraphTexts: ['First section'],
      title: 'Notebook',
    });

    try {
      const inkSectionId = addCoppermindBlockSuiteInkSection(runtime.doc);
      const secondInkSectionId = addCoppermindBlockSuiteInkSection(runtime.doc);
      const shortInkSectionId = addCoppermindBlockSuiteInkSection(runtime.doc);
      const stroke: CoppermindInkStroke = {
        color: '#111827',
        id: 'ink:test:1',
        points: [
          { t: 0, x: 10, y: 880, pressure: 0.5 },
          { t: 16, x: 120, y: 900, pressure: 0.72, tiltX: 12, tiltY: -4 },
        ],
        width: 2.6,
      };
      const shortStroke: CoppermindInkStroke = {
        ...stroke,
        id: 'ink:test:short',
        points: [
          { t: 0, x: 20, y: 22, pressure: 0.5 },
          { t: 16, x: 120, y: 32, pressure: 0.72 },
        ],
      };
      const expectedStrokeHeight = 900 + coppermindInkContentPaddingPx;

      expect(getCoppermindInkContentHeight([])).toBe(coppermindInkCellMinHeightPx);
      expect(getCoppermindInkContentHeight([shortStroke])).toBe(coppermindInkCellMinHeightPx);
      expect(getCoppermindInkContentHeight([stroke])).toBe(expectedStrokeHeight);
      expect(normalizeCoppermindInkBackground(undefined)).toBe('college');
      expect(normalizeCoppermindInkBackground('irish')).toBe('irish');
      expect(normalizeCoppermindInkBackground('invalid')).toBe('college');
      setInkStrokeData(runtime.doc, inkSectionId, [stroke]);
      setInkStrokeData(runtime.doc, shortInkSectionId, [shortStroke]);
      setInkBackground(runtime.doc, inkSectionId, 'irish');
      setInkBackground(runtime.doc, secondInkSectionId, 'grid');
      expect(setCoppermindInkCellStackState(runtime.doc, secondInkSectionId, 'unstacked')).toBe(true);

      expect(getCoppermindBlockSuiteSections(runtime.doc)).toMatchObject([
        { kind: 'blocks', height: coppermindCanvasDefaultCellHeightPx, title: 'First section' },
        {
          id: inkSectionId,
          isEmpty: false,
          kind: 'ink',
          height: expectedStrokeHeight,
          heightMode: 'clamped',
          stackState: 'auto',
          title: 'Ink Cell 2',
        },
        {
          id: secondInkSectionId,
          isEmpty: true,
          kind: 'ink',
          height: coppermindInkCellMinHeightPx,
          heightMode: 'clamped',
          stackState: 'unstacked',
          title: 'Ink Cell 3',
        },
        {
          id: shortInkSectionId,
          isEmpty: false,
          kind: 'ink',
          height: coppermindInkCellMinHeightPx,
          heightMode: 'clamped',
          stackState: 'auto',
          title: 'Ink Cell 4',
        },
      ]);

      expect(setCoppermindInkCellHeightMode(runtime.doc, inkSectionId, 'full')).toBe(true);
      expect(getCoppermindBlockSuiteSections(runtime.doc)[1]).toMatchObject({
        height: coppermindA4PageHeightPx,
        heightMode: 'full',
        kind: 'ink',
      });

      const tallStroke: CoppermindInkStroke = {
        ...stroke,
        id: 'ink:test:2',
        points: [{ t: 0, x: 20, y: coppermindA4PageHeightPx + 200 }],
      };
      setInkStrokeData(runtime.doc, secondInkSectionId, [tallStroke]);
      expect(getCoppermindBlockSuiteSections(runtime.doc)[2].height).toBe(coppermindA4PageHeightPx);

      const importedRuntime = await importCoppermindBlockSuiteRuntime(
        exportCoppermindBlockSuiteSnapshot(runtime),
      );
      try {
        const importedSections = getCoppermindBlockSuiteSections(importedRuntime.doc);
        expect(importedSections).toMatchObject([
          { kind: 'blocks', title: 'First section' },
          { kind: 'ink', height: coppermindA4PageHeightPx, heightMode: 'full', stackState: 'auto' },
          {
            kind: 'ink',
            height: coppermindA4PageHeightPx,
            heightMode: 'clamped',
            stackState: 'unstacked',
          },
          { kind: 'ink', height: coppermindInkCellMinHeightPx, heightMode: 'clamped', stackState: 'auto' },
        ]);

        const importedInkCell = findSnapshotBlock(
          exportCoppermindBlockSuiteSnapshot(importedRuntime).blocks,
          coppermindInkCellFlavour,
        );
        const importedInkCells = findSnapshotBlocks(
          exportCoppermindBlockSuiteSnapshot(importedRuntime).blocks,
          coppermindInkCellFlavour,
        );
        const parsedStrokeData = JSON.parse(String(importedInkCell?.props.strokeData ?? '{}')) as {
          strokes?: CoppermindInkStroke[];
          version?: number;
        };
        expect(importedInkCell?.props.heightMode).toBe('full');
        expect(importedInkCells.map(block => block.props.background)).toEqual(['irish', 'grid', 'college']);
        expect(parsedStrokeData.version).toBe(1);
        expect(parsedStrokeData.strokes?.[0]?.points[1]).toMatchObject({
          pressure: 0.72,
          tiltX: 12,
          tiltY: -4,
          y: 900,
        });
      } finally {
        disposeCoppermindBlockSuiteRuntime(importedRuntime);
      }
    } finally {
      disposeCoppermindBlockSuiteRuntime(runtime);
    }
  });

  it('places and unplaces BlockSuite sections without changing Page order', () => {
    const runtime = createCoppermindBlockSuiteRuntime({
      docId: 'doc:notebook',
      now: new Date('2026-06-30T10:00:00.000Z'),
      paragraphTexts: ['First section'],
      title: 'Notebook',
    });

    try {
      const secondSectionId = addCoppermindBlockSuiteSection(runtime.doc);
      const firstSectionId = getCoppermindBlockSuiteSections(runtime.doc)[0].id;
      const xywh = createCoppermindSectionXYWHAtCenter(1200, 900);

      expect(xywh[2]).toBe(coppermindCellWidthPx);
      expect(placeCoppermindBlockSuiteSection(runtime.doc, secondSectionId, xywh)).toBe(true);
      expect(getCoppermindBlockSuiteSections(runtime.doc)).toMatchObject([
        {
          id: firstSectionId,
          placement: { state: 'unplaced' },
        },
        {
          id: secondSectionId,
          placement: { state: 'placed', xywh },
        },
      ]);

      expect(unplaceCoppermindBlockSuiteSection(runtime.doc, secondSectionId)).toBe(true);
      expect(getCoppermindBlockSuiteSections(runtime.doc)).toMatchObject([
        {
          id: firstSectionId,
          placement: { state: 'unplaced' },
        },
        {
          id: secondSectionId,
          placement: { state: 'unplaced' },
        },
      ]);
    } finally {
      disposeCoppermindBlockSuiteRuntime(runtime);
    }
  });

  it('reorders BlockSuite sections while preserving contents and placement', () => {
    const runtime = createCoppermindBlockSuiteRuntime({
      docId: 'doc:notebook',
      now: new Date('2026-06-30T10:00:00.000Z'),
      paragraphTexts: ['First section'],
      title: 'Notebook',
    });

    try {
      const firstSectionId = getCoppermindBlockSuiteSections(runtime.doc)[0].id;
      const secondSectionId = addCoppermindBlockSuiteSection(runtime.doc);
      const thirdSectionId = addCoppermindBlockSuiteSection(runtime.doc);
      const xywh = createCoppermindSectionXYWHAtCenter(1200, 900);

      setSectionText(runtime.doc, secondSectionId, 'Second section');
      setSectionText(runtime.doc, thirdSectionId, 'Third section');
      expect(placeCoppermindBlockSuiteSection(runtime.doc, secondSectionId, xywh)).toBe(true);

      expect(reorderCoppermindBlockSuiteSection(runtime.doc, thirdSectionId, firstSectionId)).toBe(true);
      expect(getCoppermindBlockSuiteSections(runtime.doc)).toMatchObject([
        { id: thirdSectionId, title: 'Third section', placement: { state: 'unplaced' } },
        { id: firstSectionId, title: 'First section', placement: { state: 'unplaced' } },
        { id: secondSectionId, title: 'Second section', placement: { state: 'placed', xywh } },
      ]);

      expect(reorderCoppermindBlockSuiteSection(runtime.doc, thirdSectionId, secondSectionId)).toBe(true);
      expect(getCoppermindBlockSuiteSections(runtime.doc)).toMatchObject([
        { id: firstSectionId, title: 'First section', placement: { state: 'unplaced' } },
        { id: secondSectionId, title: 'Second section', placement: { state: 'placed', xywh } },
        { id: thirdSectionId, title: 'Third section', placement: { state: 'unplaced' } },
      ]);
    } finally {
      disposeCoppermindBlockSuiteRuntime(runtime);
    }
  });

  it('ignores invalid BlockSuite section reorder requests', () => {
    const runtime = createCoppermindBlockSuiteRuntime({
      docId: 'doc:notebook',
      now: new Date('2026-06-30T10:00:00.000Z'),
      paragraphTexts: ['First section'],
      title: 'Notebook',
    });

    try {
      const firstSectionId = getCoppermindBlockSuiteSections(runtime.doc)[0].id;
      const secondSectionId = addCoppermindBlockSuiteSection(runtime.doc);
      const surfaceId = runtime.doc.root?.children.find(child => child.flavour === 'affine:surface')?.id;
      const originalOrder = getCoppermindBlockSuiteSections(runtime.doc).map(section => section.id);

      expect(reorderCoppermindBlockSuiteSection(runtime.doc, firstSectionId, firstSectionId)).toBe(false);
      expect(reorderCoppermindBlockSuiteSection(runtime.doc, 'missing-section', secondSectionId)).toBe(false);
      expect(reorderCoppermindBlockSuiteSection(runtime.doc, firstSectionId, 'missing-section')).toBe(false);
      if (surfaceId) {
        expect(reorderCoppermindBlockSuiteSection(runtime.doc, firstSectionId, surfaceId)).toBe(false);
      }
      expect(getCoppermindBlockSuiteSections(runtime.doc).map(section => section.id)).toEqual(originalOrder);
    } finally {
      disposeCoppermindBlockSuiteRuntime(runtime);
    }
  });

  it('calculates new canvas cell placement centered below placed bounds', () => {
    const runtime = createCoppermindBlockSuiteRuntime({
      docId: 'doc:notebook',
      now: new Date('2026-06-30T10:00:00.000Z'),
      paragraphTexts: ['First section'],
      title: 'Notebook',
    });

    try {
      const firstSectionId = getCoppermindBlockSuiteSections(runtime.doc)[0].id;
      const firstXYWH = createCoppermindNextCanvasCellXYWH(getCoppermindBlockSuiteSections(runtime.doc));

      expect(firstXYWH).toEqual([
        -coppermindCellWidthPx / 2,
        0,
        coppermindCellWidthPx,
        coppermindCanvasDefaultCellHeightPx,
      ]);

      expect(placeCoppermindBlockSuiteSection(runtime.doc, firstSectionId, firstXYWH)).toBe(true);
      expect(createCoppermindNextCanvasCellXYWH(getCoppermindBlockSuiteSections(runtime.doc))).toEqual([
        -coppermindCellWidthPx / 2,
        firstXYWH[1] + firstXYWH[3] + coppermindCanvasCellGapPx,
        coppermindCellWidthPx,
        firstXYWH[3],
      ]);

      const secondSectionId = addCoppermindBlockSuiteSection(runtime.doc);
      const lowerCustomBounds: [number, number, number, number] = [1600, 1200, 300, 180];
      expect(placeCoppermindBlockSuiteSection(runtime.doc, secondSectionId, lowerCustomBounds)).toBe(true);
      expect(createCoppermindNextCanvasCellXYWH(getCoppermindBlockSuiteSections(runtime.doc))).toEqual([
        -coppermindCellWidthPx / 2,
        lowerCustomBounds[1] + lowerCustomBounds[3] + coppermindCanvasCellGapPx,
        coppermindCellWidthPx,
        firstXYWH[3],
      ]);
    } finally {
      disposeCoppermindBlockSuiteRuntime(runtime);
    }
  });
});
