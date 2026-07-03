import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19';
import { PortalWorkspaceFileHost } from './workspace-files.ts';

const withWorkspaceFileHost = async (
  callback: (context: { root: string; host: PortalWorkspaceFileHost }) => Promise<void>,
) => {
  const root = await Deno.makeTempDir({ prefix: 'weave-workspace-file-root-' });
  const host = new PortalWorkspaceFileHost({ config: {}, maxReadBytes: 1024 * 1024, maxIndexBytes: 1024 * 1024 });

  try {
    await callback({ root: await Deno.realPath(root), host });
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
};

const coppermindDocument = JSON.stringify({
  kind: 'coppermind.document',
  version: 2,
  metadata: {
    title: 'Research Notebook',
    createdAt: '2026-06-30T10:00:00.000Z',
    updatedAt: '2026-06-30T10:00:00.000Z',
  },
  blocksuite: {
    format: 'snapshot',
    packageVersion: '0.19.5',
    docId: 'doc:research-notebook',
    snapshot: {
      type: 'page',
      meta: {
        id: 'doc:research-notebook',
        title: 'Research Notebook',
        createDate: 1782813600000,
        updatedDate: 1782813600000,
        tags: [],
      },
      blocks: {
        type: 'block',
        id: 'page:research-notebook',
        flavour: 'affine:page',
        version: 2,
        props: {
          title: {
            '$blocksuite:internal:text$': true,
            delta: [{ insert: 'Research Notebook' }],
          },
        },
        children: [
          {
            type: 'block',
            id: 'surface:research-notebook',
            flavour: 'affine:surface',
            version: 5,
            props: { elements: {} },
            children: [],
          },
          {
            type: 'block',
            id: 'note:research-notebook',
            flavour: 'affine:note',
            version: 1,
            props: {},
            children: [
              {
                type: 'block',
                id: 'paragraph:research-notebook',
                flavour: 'affine:paragraph',
                version: 1,
                props: {
                  type: 'text',
                  text: {
                    '$blocksuite:internal:text$': true,
                    delta: [{ insert: 'A note body' }],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      },
    },
  },
  ui: { lastMode: 'page' },
});

Deno.test('PortalWorkspaceFileHost reads, writes, and indexes .cpr documents as notes', async () =>
  await withWorkspaceFileHost(async ({ root, host }) => {
    const target = { workspacePath: root };
    await Deno.writeTextFile(`${root}/Notebook.cpr`, coppermindDocument);
    await Deno.writeTextFile(`${root}/Legacy.md`, '# Legacy\n[[Notebook]]\n');
    await Deno.writeTextFile(`${root}/Sketch.excalidraw`, '{"elements":[]}');

    const file = await host.read({ target, path: 'Notebook.cpr' });
    assertEquals(file.path, 'Notebook.cpr');
    assertEquals(file.content, coppermindDocument);

    const saved = await host.write({ target, path: 'Next.cpr', content: coppermindDocument });
    assertEquals(saved.path, 'Next.cpr');
    assertEquals(await Deno.readTextFile(`${root}/Next.cpr`), coppermindDocument);

    const index = await host.index({ target, path: '' });
    assertEquals(index.notes.map(note => `${note.documentType}:${note.path}`).sort(), [
      'coppermind:Next.cpr',
      'coppermind:Notebook.cpr',
      'markdown:Legacy.md',
    ]);
    assertEquals(index.notes.find(note => note.path === 'Notebook.cpr')?.title, 'Research Notebook');
    assertEquals(index.notes.find(note => note.path === 'Notebook.cpr')?.preview, 'A note body');
    assertEquals(index.attachments.map(attachment => attachment.path), ['Sketch.excalidraw']);
    assertEquals(index.backlinks['Notebook.cpr'], ['Legacy.md']);
  }));

Deno.test('PortalWorkspaceFileHost rejects non-text workspace files while allowing .cpr text files', async () =>
  await withWorkspaceFileHost(async ({ root, host }) => {
    const target = { workspacePath: root };
    await Deno.writeFile(`${root}/bin.dat`, new Uint8Array([0x66, 0x00, 0x6f]));
    await Deno.writeTextFile(`${root}/Notebook.cpr`, coppermindDocument);

    assertEquals((await host.read({ target, path: 'Notebook.cpr' })).content, coppermindDocument);
    await assertRejects(
      () => host.read({ target, path: 'bin.dat' }),
      Error,
      'Binary files cannot be opened in the workspace.',
    );
  }));
