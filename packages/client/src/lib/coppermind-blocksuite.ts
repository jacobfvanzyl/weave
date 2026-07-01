import { AffineSchemas } from '@blocksuite/blocks/schemas';
import { DocCollection, Job, Schema, Text, type BlockModel, type Doc, type DocSnapshot } from '@blocksuite/store';

export const coppermindBlockSuitePackageVersion = '0.19.5';

const defaultSectionWidth = 800;
const defaultSectionHeight = 640;
const sectionGap = 160;
type SerializedXYWH = `[${number},${number},${number},${number}]`;

export type CoppermindBlockSuiteRuntime = {
  collection: DocCollection;
  doc: Doc;
};

export type CoppermindBlockSuiteSection = {
  childCount: number;
  id: string;
  isEmpty: boolean;
  title: string;
};

export type CreateCoppermindBlockSuiteRuntimeOptions = {
  docId: string;
  now?: Date;
  paragraphTexts?: string[];
  title: string;
};

const createCollection = () => {
  const schema = new Schema().register(AffineSchemas);
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

const blockHasAuthoredContent = (block: BlockModel): boolean => {
  if (getBlockText(block)) return true;
  if (block.flavour !== 'affine:paragraph' && block.flavour !== 'affine:list') return true;
  return block.children.some(blockHasAuthoredContent);
};

const getSectionTitle = (note: BlockModel, index: number) => {
  const heading = note.children.find(child => {
    const model = asCoppermindBlockModel(child);
    return model.flavour === 'affine:paragraph' && /^h[1-6]$/.test(model.type ?? '') && getBlockText(child);
  });
  const firstTextBlock = note.children.find(child => getBlockText(child));

  return getBlockText(heading ?? firstTextBlock ?? note) || `Untitled section ${index + 1}`;
};

const parseSerializedXYWH = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === 4
      && parsed.every(item => typeof item === 'number' && Number.isFinite(item))
    ) {
      const [x, y, w, h] = parsed;
      return { x, y, w, h };
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const serializeXYWH = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => (
  `[${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}]` as SerializedXYWH
);

const getNextSectionXYWH = (notes: CoppermindBlockModel[]) => {
  const lastBound = notes
    .map(note => parseSerializedXYWH(note.xywh))
    .filter((bound): bound is { x: number; y: number; w: number; h: number } => Boolean(bound))
    .at(-1);

  if (!lastBound) {
    return serializeXYWH({ x: 0, y: 0, w: defaultSectionWidth, h: defaultSectionHeight });
  }

  return serializeXYWH({
    x: lastBound.x + lastBound.w + sectionGap,
    y: lastBound.y,
    w: lastBound.w || defaultSectionWidth,
    h: lastBound.h || defaultSectionHeight,
  });
};

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
    const noteId = doc.addBlock('affine:note', {}, pageBlockId);
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
    id: note.id,
    isEmpty: !note.children.some(blockHasAuthoredContent),
    title: getSectionTitle(note, index),
  }))
);

export const addCoppermindBlockSuiteSection = (doc: Doc) => {
  const root = doc.root;
  if (!root) throw new Error('Cannot add a Coppermind section before the document root is loaded.');

  const notes = getPageVisibleNotes(doc);
  const noteId = doc.addBlock(
    'affine:note',
    { xywh: getNextSectionXYWH(notes) },
    root,
  );
  doc.addBlock('affine:paragraph', {}, noteId);
  return noteId;
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
