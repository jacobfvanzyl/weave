import { NoteDisplayMode } from '@blocksuite/blocks';
import { AffineSchemas } from '@blocksuite/blocks/schemas';
import { DocCollection, Job, Schema, Text, type BlockModel, type Doc, type DocSnapshot } from '@blocksuite/store';

import {
  CoppermindInkCellSchema,
  coppermindInkCellFlavour,
  getCoppermindInkCellHeight,
  getCoppermindInkStrokeCount,
  normalizeCoppermindInkHeightMode,
  parseCoppermindInkStrokeData,
  type CoppermindInkHeightMode,
  type CoppermindInkStackState,
} from './coppermind-ink-cell';
import {
  coppermindA4PageHeightPx,
  coppermindCanvasDefaultCellHeightPx,
  coppermindCanvasCellGapPx,
  coppermindCellWidthPx,
  coppermindInkCellMinHeightPx,
} from './coppermind-layout';

export { coppermindCanvasCellGapPx, coppermindCellWidthPx } from './coppermind-layout';

export const coppermindBlockSuitePackageVersion = '0.19.5';

const defaultSectionWidth = coppermindCellWidthPx;
const defaultSectionHeight = coppermindCanvasDefaultCellHeightPx;
type SerializedXYWH = `[${number},${number},${number},${number}]`;
const noteDisplayModePageOnly = NoteDisplayMode.DocOnly;
const noteDisplayModePageAndCanvas = NoteDisplayMode.DocAndEdgeless;
const inkCellStackStateAuto: CoppermindInkStackState = 'auto';

export type CoppermindBlockSuiteRuntime = {
  collection: DocCollection;
  doc: Doc;
};

export type CoppermindBlockSuiteSectionXYWH = [x: number, y: number, w: number, h: number];

export type CoppermindBlockSuiteSectionPlacement =
  | { state: 'unplaced' }
  | { state: 'placed'; xywh: CoppermindBlockSuiteSectionXYWH };

export type CoppermindBlockSuiteSection = {
  childCount: number;
  height: number;
  heightMode?: CoppermindInkHeightMode;
  id: string;
  isEmpty: boolean;
  kind: 'blocks' | 'ink';
  placement: CoppermindBlockSuiteSectionPlacement;
  stackState: CoppermindInkStackState;
  title: string;
};

export type CreateCoppermindBlockSuiteRuntimeOptions = {
  docId: string;
  now?: Date;
  paragraphTexts?: string[];
  title: string;
};

const createCollection = () => {
  const schema = new Schema().register([...AffineSchemas, CoppermindInkCellSchema]);
  const noteSchema = schema.flavourSchemaMap.get('affine:note');
  const noteChildren = noteSchema?.model.children;
  if (noteSchema && noteChildren && !noteChildren.includes(coppermindInkCellFlavour)) {
    noteSchema.model.children = [...noteChildren, coppermindInkCellFlavour];
  }
  const collection = new DocCollection({ schema });
  collection.meta.initialize();
  return collection;
};

const normalizeParagraphTexts = (texts: string[] | undefined) => {
  const cleaned = texts?.map(text => text.trim()).filter(Boolean) ?? [];
  return cleaned.length ? cleaned : [''];
};

type TextLike = {
  toString: () => string;
};

type CoppermindBlockModel = BlockModel & {
  displayMode?: string;
  height?: number;
  heightMode?: CoppermindInkHeightMode;
  stackState?: CoppermindInkStackState;
  strokeData?: string;
  text?: TextLike;
  type?: string;
  xywh?: SerializedXYWH;
};

const asCoppermindBlockModel = (block: BlockModel) => block as CoppermindBlockModel;

const isPageVisibleNote = (block: BlockModel) => {
  const model = asCoppermindBlockModel(block);
  return model.flavour === 'affine:note' && model.displayMode !== 'edgeless';
};

const getPageVisibleNotes = (doc: Doc) => (
  doc.root?.children.filter(isPageVisibleNote).map(asCoppermindBlockModel) ?? []
);

const getBlockText = (block: BlockModel) => (
  asCoppermindBlockModel(block).text?.toString().trim() ?? ''
);

const getInkCellChild = (note: BlockModel) => (
  note.children.find(child => child.flavour === coppermindInkCellFlavour)
);

const isInkSection = (note: BlockModel) => Boolean(getInkCellChild(note));

const getInkCellModel = (block: BlockModel | undefined) => (
  block ? asCoppermindBlockModel(block) : undefined
);

const getInkSectionHeight = (note: BlockModel) => {
  const inkCell = getInkCellModel(getInkCellChild(note));
  const heightMode = normalizeCoppermindInkHeightMode(inkCell?.heightMode);
  const strokeHeight = getCoppermindInkCellHeight(
    parseCoppermindInkStrokeData(inkCell?.strokeData).strokes,
    heightMode,
  );
  return Math.min(
    coppermindA4PageHeightPx,
    Math.max(
      coppermindInkCellMinHeightPx,
      strokeHeight,
    ),
  );
};

const getInkHeightMode = (note: BlockModel): CoppermindInkHeightMode => (
  normalizeCoppermindInkHeightMode(getInkCellModel(getInkCellChild(note))?.heightMode)
);

const getInkStackState = (note: BlockModel): CoppermindInkStackState => {
  const stackState = getInkCellModel(getInkCellChild(note))?.stackState;
  return stackState === 'unstacked' ? stackState : inkCellStackStateAuto;
};

const blockHasAuthoredContent = (block: BlockModel): boolean => {
  if (block.flavour === coppermindInkCellFlavour) {
    return getCoppermindInkStrokeCount(asCoppermindBlockModel(block).strokeData) > 0;
  }
  if (getBlockText(block)) return true;
  if (block.flavour !== 'affine:paragraph' && block.flavour !== 'affine:list') return true;
  return block.children.some(blockHasAuthoredContent);
};

const getSectionTitle = (note: BlockModel, index: number) => {
  if (isInkSection(note)) return `Ink Cell ${index + 1}`;

  const heading = note.children.find(child => {
    const model = asCoppermindBlockModel(child);
    return model.flavour === 'affine:paragraph' && /^h[1-6]$/.test(model.type ?? '') && getBlockText(child);
  });
  const firstTextBlock = note.children.find(child => getBlockText(child));

  return getBlockText(heading ?? firstTextBlock ?? note) || `Untitled cell ${index + 1}`;
};

const defaultSectionXYWH = (): CoppermindBlockSuiteSectionXYWH => [
  0,
  0,
  defaultSectionWidth,
  defaultSectionHeight,
];

export const createCoppermindSectionXYWHAtCenter = (
  x: number,
  y: number,
): CoppermindBlockSuiteSectionXYWH => [
  x - defaultSectionWidth / 2,
  y - defaultSectionHeight / 2,
  defaultSectionWidth,
  defaultSectionHeight,
];

export const createCoppermindSectionXYWHAtTopLeft = (
  x: number,
  y: number,
): CoppermindBlockSuiteSectionXYWH => [
  x,
  y,
  defaultSectionWidth,
  defaultSectionHeight,
];

export const createCoppermindNextCanvasCellXYWH = (
  sections: CoppermindBlockSuiteSection[],
): CoppermindBlockSuiteSectionXYWH => {
  const placedBounds = sections.flatMap(section => (
    section.placement.state === 'placed' ? [section.placement.xywh] : []
  ));
  const lowestPlacedBottom = placedBounds.reduce(
    (lowest, [, y, , height]) => Math.max(lowest, y + height),
    Number.NEGATIVE_INFINITY,
  );
  const y = Number.isFinite(lowestPlacedBottom)
    ? Math.max(0, lowestPlacedBottom + coppermindCanvasCellGapPx)
    : 0;

  return [
    -defaultSectionWidth / 2,
    y,
    defaultSectionWidth,
    defaultSectionHeight,
  ];
};

const parseSerializedXYWH = (value: string | undefined): CoppermindBlockSuiteSectionXYWH | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === 4
      && parsed.every(item => typeof item === 'number' && Number.isFinite(item))
    ) {
      const [x, y, w, h] = parsed;
      return [x, y, w, h];
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const serializeXYWH = ([x, y, w, h]: CoppermindBlockSuiteSectionXYWH) => (
  `[${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}]` as SerializedXYWH
);

const getSectionPlacement = (note: CoppermindBlockModel): CoppermindBlockSuiteSectionPlacement => (
  note.displayMode === noteDisplayModePageOnly
    ? { state: 'unplaced' }
    : { state: 'placed', xywh: parseSerializedXYWH(note.xywh) ?? defaultSectionXYWH() }
);

export const createCoppermindBlockSuiteRuntime = ({
  docId,
  now,
  paragraphTexts,
  title,
}: CreateCoppermindBlockSuiteRuntimeOptions): CoppermindBlockSuiteRuntime => {
  const collection = createCollection();
  const doc = collection.createDoc({ id: docId });
  const timestamp = now?.getTime();

  doc.load(() => {
    const pageBlockId = doc.addBlock('affine:page', { title: new Text(title) });
    doc.addBlock('affine:surface', {}, pageBlockId);
    const noteId = doc.addBlock('affine:note', { displayMode: noteDisplayModePageOnly }, pageBlockId);
    for (const text of normalizeParagraphTexts(paragraphTexts)) {
      doc.addBlock('affine:paragraph', { text: new Text(text) }, noteId);
    }
  });

  if (timestamp !== undefined) {
    collection.setDocMeta(doc.id, {
      createDate: timestamp,
      updatedDate: timestamp,
    });
  }

  return { collection, doc };
};

export const getCoppermindBlockSuiteSections = (doc: Doc): CoppermindBlockSuiteSection[] => (
  getPageVisibleNotes(doc).map((note, index) => ({
    childCount: note.children.length,
    height: isInkSection(note) ? getInkSectionHeight(note) : defaultSectionHeight,
    heightMode: isInkSection(note) ? getInkHeightMode(note) : undefined,
    id: note.id,
    isEmpty: !note.children.some(blockHasAuthoredContent),
    kind: isInkSection(note) ? 'ink' : 'blocks',
    placement: getSectionPlacement(note),
    stackState: getInkStackState(note),
    title: getSectionTitle(note, index),
  }))
);

export const reorderCoppermindBlockSuiteSection = (
  doc: Doc,
  activeId: string,
  overId: string,
) => {
  if (activeId === overId) return false;
  const root = doc.root;
  if (!root) return false;

  const sections = getPageVisibleNotes(doc);
  const activeIndex = sections.findIndex(section => section.id === activeId);
  const overIndex = sections.findIndex(section => section.id === overId);
  if (activeIndex < 0 || overIndex < 0) return false;

  const activeSection = sections[activeIndex];
  const overSection = sections[overIndex];
  doc.moveBlocks([activeSection], root, overSection, activeIndex > overIndex);
  return true;
};

const addCoppermindBlockSuiteSectionNote = (doc: Doc) => {
  const root = doc.root;
  if (!root) throw new Error('Cannot add a Coppermind section before the document root is loaded.');

  return doc.addBlock(
    'affine:note',
    { displayMode: noteDisplayModePageOnly },
    root,
  );
};

export const addCoppermindBlockSuiteBlocksSection = (doc: Doc) => {
  const noteId = addCoppermindBlockSuiteSectionNote(doc);
  doc.addBlock('affine:paragraph', {}, noteId);
  return noteId;
};

export const addCoppermindBlockSuiteInkSection = (doc: Doc) => {
  const noteId = addCoppermindBlockSuiteSectionNote(doc);
  doc.addBlock(coppermindInkCellFlavour, {}, noteId);
  return noteId;
};

export const addCoppermindBlockSuiteSection = addCoppermindBlockSuiteBlocksSection;

export const setCoppermindInkCellStackState = (
  doc: Doc,
  sectionId: string,
  stackState: CoppermindInkStackState,
) => {
  const section = doc.getBlockById(sectionId);
  if (!section || section.flavour !== 'affine:note') return false;

  const inkCell = getInkCellChild(section);
  if (!inkCell || inkCell.flavour !== coppermindInkCellFlavour) return false;

  doc.updateBlock(inkCell, { stackState });
  return true;
};

export const setCoppermindInkCellHeightMode = (
  doc: Doc,
  sectionId: string,
  heightMode: CoppermindInkHeightMode,
) => {
  const section = doc.getBlockById(sectionId);
  if (!section || section.flavour !== 'affine:note') return false;

  const inkCell = getInkCellChild(section);
  if (!inkCell || inkCell.flavour !== coppermindInkCellFlavour) return false;

  const normalizedHeightMode = normalizeCoppermindInkHeightMode(heightMode);
  doc.updateBlock(inkCell, {
    height: getCoppermindInkCellHeight(
      parseCoppermindInkStrokeData(asCoppermindBlockModel(inkCell).strokeData).strokes,
      normalizedHeightMode,
    ),
    heightMode: normalizedHeightMode,
  });
  return true;
};

export const placeCoppermindBlockSuiteSection = (
  doc: Doc,
  sectionId: string,
  xywh: CoppermindBlockSuiteSectionXYWH,
) => {
  const section = doc.getBlockById(sectionId);
  if (!section || section.flavour !== 'affine:note') return false;

  doc.updateBlock(section, {
    displayMode: noteDisplayModePageAndCanvas,
    xywh: serializeXYWH(xywh),
  });
  return true;
};

export const unplaceCoppermindBlockSuiteSection = (doc: Doc, sectionId: string) => {
  const section = doc.getBlockById(sectionId);
  if (!section || section.flavour !== 'affine:note') return false;

  doc.updateBlock(section, { displayMode: noteDisplayModePageOnly });
  return true;
};

export const deleteCoppermindBlockSuiteSection = (doc: Doc, sectionId: string) => {
  const section = doc.getBlockById(sectionId);
  if (!section || section.flavour !== 'affine:note') return false;
  doc.deleteBlock(section, { deleteChildren: true });
  return true;
};

export const importCoppermindBlockSuiteRuntime = async (
  snapshot: DocSnapshot,
): Promise<CoppermindBlockSuiteRuntime> => {
  const collection = createCollection();
  const doc = await new Job({ collection }).snapshotToDoc(snapshot);
  if (!doc) {
    collection.dispose();
    throw new Error('Unable to import Coppermind BlockSuite snapshot.');
  }
  return { collection, doc };
};

export const exportCoppermindBlockSuiteSnapshot = (
  runtime: CoppermindBlockSuiteRuntime,
  options: { now?: Date; title?: string } = {},
): DocSnapshot => {
  const snapshot = new Job({ collection: runtime.collection }).docToSnapshot(runtime.doc);
  if (!snapshot) throw new Error('Unable to export Coppermind BlockSuite snapshot.');

  const now = options.now?.getTime();
  return {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      title: options.title ?? snapshot.meta.title,
      updatedDate: now ?? snapshot.meta.updatedDate,
    },
  };
};

export const disposeCoppermindBlockSuiteRuntime = (runtime: CoppermindBlockSuiteRuntime | undefined) => {
  runtime?.collection.dispose();
};
