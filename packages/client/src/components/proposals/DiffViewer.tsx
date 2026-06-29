import { useEffect, useMemo, useRef } from 'react';
import { syntaxHighlighting } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getCodeMirrorLanguageExtensions } from '../../lib/codemirror-languages';
import { editorBasicSetup, editorTheme, weaveHighlightStyle } from '../../lib/codemirror-theme';

type DiffViewerProps = {
  path?: string;
  originalText: string;
  proposedText: string;
};

export const parseUnifiedDiffForPreview = (value: string) => {
  const original: string[] = [];
  const proposed: string[] = [];
  let inHunk = false;
  let previousProposedEnd: number | undefined;

  for (const line of value.split('\n')) {
    if (line.startsWith('@@ ')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (inHunk && proposed.length > 0) {
        const nextProposedStart = hunk ? Number(hunk[1]) : undefined;
        const hiddenLines = nextProposedStart !== undefined && previousProposedEnd !== undefined
          ? Math.max(0, nextProposedStart - previousProposedEnd - 1)
          : undefined;
        const marker = hiddenLines && hiddenLines > 0
          ? `// ---- ${hiddenLines} unchanged lines hidden ----`
          : '// ---- unchanged lines hidden ----';
        original.push(marker);
        proposed.push(marker);
      }
      inHunk = true;
      if (hunk) {
        const start = Number(hunk[1]);
        const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
        previousProposedEnd = start + Math.max(length, 1) - 1;
      }
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+')) {
      proposed.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      original.push(line.slice(1));
      continue;
    }
    if (line.startsWith(' ')) {
      original.push(line.slice(1));
      proposed.push(line.slice(1));
      continue;
    }
    original.push(line);
    proposed.push(line);
  }

  return {
    originalText: original.join('\n'),
    proposedText: proposed.join('\n'),
  };
};

const diffTheme = EditorView.theme({
  '&': {
    height: '100%',
  },
  '.cm-mergeView': {
    height: '100%',
  },
  '.cm-changedLine': {
    backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--destructive) 12%, transparent)',
  },
  '.cm-insertedLine': {
    backgroundColor: 'transparent',
    textDecoration: 'none',
  },
  '.cm-deletedLine, .cm-deletedLine del': {
    textDecoration: 'none',
  },
  '.cm-changedText, .cm-deletedText': {
    background: 'transparent !important',
  },
  '.cm-collapsedLines': {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    minHeight: '30px',
    padding: '0 14px',
    color: 'var(--muted-foreground)',
    background: 'var(--background)',
    borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
    fontSize: '12px',
  },
  '.cm-collapsedLines:before, .cm-collapsedLines:after': {
    content: '""',
    height: '1px',
    flex: '1 1 auto',
    background: 'color-mix(in srgb, var(--border) 70%, transparent)',
  },
  '.cm-collapsedLines:hover': {
    background: 'var(--muted)',
    color: 'var(--foreground)',
  },
});

export const DiffViewer = ({ path, originalText, proposedText }: DiffViewerProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const parsedUnifiedDiff = useMemo(
    () => !originalText.trim() && /^(@@ |diff --git )/m.test(proposedText)
      ? parseUnifiedDiffForPreview(proposedText)
      : undefined,
    [originalText, proposedText],
  );
  const displayOriginalText = parsedUnifiedDiff?.originalText ?? originalText;
  const displayProposedText = parsedUnifiedDiff?.proposedText ?? proposedText;
  const isWholeNewFile = !parsedUnifiedDiff && !originalText.trim() && proposedText.trim().length > 0;
  const extensions = useMemo(() => [
    editorBasicSetup,
    editorTheme,
    syntaxHighlighting(weaveHighlightStyle),
    ...getCodeMirrorLanguageExtensions(path),
    ...(isWholeNewFile ? [] : [
      unifiedMergeView({
        original: displayOriginalText,
        gutter: true,
        mergeControls: false,
        allowInlineDiffs: false,
        collapseUnchanged: { margin: 3, minSize: 8 },
      }),
    ]),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    diffTheme,
  ], [displayOriginalText, isWholeNewFile, path]);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return undefined;
    parent.textContent = '';
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: displayProposedText,
        extensions,
      }),
    });
    return () => view.destroy();
  }, [displayProposedText, extensions]);

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" data-weave-diff-viewer />;
};
