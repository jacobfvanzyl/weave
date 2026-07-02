export type UnifiedDiffLine = {
  kind: 'context' | 'add' | 'delete';
  text: string;
};

export type UnifiedDiffHunk = {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  lines: UnifiedDiffLine[];
};

export type ParsedUnifiedDiff = {
  hunks: UnifiedDiffHunk[];
  additions: number;
  deletions: number;
};

export type UnifiedDiffFileSection = {
  path: string;
  oldPath?: string;
  newPath?: string;
  diff: string;
};

export type UnifiedDiffResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const normalizeLineEndings = (value: string) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const splitContentLines = (value: string) => {
  const normalized = normalizeLineEndings(value);
  const trailingNewline = normalized.endsWith('\n');
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body ? body.split('\n') : [],
    trailingNewline,
    lineEnding: value.includes('\r\n') ? '\r\n' : '\n',
  };
};

const joinContentLines = (lines: string[], trailingNewline: boolean, lineEnding: string) => {
  const normalized = `${lines.join('\n')}${trailingNewline && lines.length > 0 ? '\n' : ''}`;
  return lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
};

const parseRangeLength = (value: string | undefined) => value === undefined ? 1 : Number(value);

const firstPathToken = (value: string) => value.trim().split(/\s+/)[0] ?? '';

export const normalizeUnifiedDiffPath = (value: string | undefined) => {
  if (typeof value !== 'string') return undefined;
  const token = firstPathToken(value);
  if (!token || token === '/dev/null') return undefined;
  if (token.startsWith('a/') || token.startsWith('b/')) return token.slice(2);
  return token;
};

const diffGitHeaderPattern = /^diff --git\s+(.+?)\s+(.+)$/;

const parseDiffGitHeader = (line: string) => {
  const match = diffGitHeaderPattern.exec(line);
  if (!match) return {};
  return {
    oldPath: normalizeUnifiedDiffPath(match[1]),
    newPath: normalizeUnifiedDiffPath(match[2]),
  };
};

const isDiffMetadataLine = (line: string) =>
  line === ''
  || line.startsWith('diff --git ')
  || line.startsWith('index ')
  || line.startsWith('new file mode ')
  || line.startsWith('deleted file mode ')
  || line.startsWith('similarity index ')
  || line.startsWith('rename from ')
  || line.startsWith('rename to ')
  || line.startsWith('--- ')
  || line.startsWith('+++ ');

const validateHunkCounts = (hunk: UnifiedDiffHunk): UnifiedDiffResult<UnifiedDiffHunk> => {
  const oldCount = hunk.lines.filter(line => line.kind === 'context' || line.kind === 'delete').length;
  const newCount = hunk.lines.filter(line => line.kind === 'context' || line.kind === 'add').length;
  if (oldCount !== hunk.oldLength || newCount !== hunk.newLength) {
    return {
      ok: false,
      error: `Unified diff hunk @@ -${hunk.oldStart},${hunk.oldLength} +${hunk.newStart},${hunk.newLength} @@ has ${oldCount}/${newCount} old/new lines.`,
    };
  }
  return { ok: true, value: hunk };
};

export const parseUnifiedDiff = (diff: string | undefined): UnifiedDiffResult<ParsedUnifiedDiff> => {
  if (typeof diff !== 'string' || !diff.trim()) {
    return { ok: false, error: 'Unified diff is required.' };
  }

  const lines = normalizeLineEndings(diff).replace(/\n$/, '').split('\n');
  const hunks: UnifiedDiffHunk[] = [];
  let current: UnifiedDiffHunk | undefined;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    const hunkHeader = hunkHeaderPattern.exec(line);
    if (hunkHeader) {
      if (current) {
        const validated = validateHunkCounts(current);
        if (!validated.ok) return validated;
        hunks.push(validated.value);
      }
      current = {
        oldStart: Number(hunkHeader[1]),
        oldLength: parseRangeLength(hunkHeader[2]),
        newStart: Number(hunkHeader[3]),
        newLength: parseRangeLength(hunkHeader[4]),
        lines: [],
      };
      continue;
    }

    if (!current) {
      if (isDiffMetadataLine(line)) continue;
      return { ok: false, error: 'Unified diff contains non-diff text before the first hunk.' };
    }

    if (line.startsWith('diff --git ')) {
      return { ok: false, error: 'A proposal file item must contain a diff for only one file.' };
    }
    if (line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.lines.push({ kind: 'add', text: line.slice(1) });
      additions += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.lines.push({ kind: 'delete', text: line.slice(1) });
      deletions += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1) });
      continue;
    }
    if (isDiffMetadataLine(line)) continue;

    return { ok: false, error: 'Unified diff hunk lines must begin with space, +, or -.' };
  }

  if (current) {
    const validated = validateHunkCounts(current);
    if (!validated.ok) return validated;
    hunks.push(validated.value);
  }
  if (hunks.length === 0) return { ok: false, error: 'Unified diff must contain at least one hunk.' };
  if (additions === 0 && deletions === 0) return { ok: false, error: 'Unified diff must contain at least one added or removed line.' };

  return { ok: true, value: { hunks, additions, deletions } };
};

const isPlainUnifiedFileHeader = (lines: string[], index: number) =>
  lines[index]?.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ');

const parseFileSectionPaths = (lines: string[]) => {
  let oldPath: string | undefined;
  let newPath: string | undefined;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parsed = parseDiffGitHeader(line);
      oldPath = parsed.oldPath ?? oldPath;
      newPath = parsed.newPath ?? newPath;
      continue;
    }

    if (line.startsWith('--- ')) {
      oldPath = normalizeUnifiedDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith('+++ ')) {
      newPath = normalizeUnifiedDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith('@@ ')) break;
  }

  return { oldPath, newPath, path: newPath ?? oldPath };
};

export const splitUnifiedDiffByFile = (diff: string | undefined): UnifiedDiffResult<UnifiedDiffFileSection[]> => {
  if (typeof diff !== 'string' || !diff.trim()) {
    return { ok: false, error: 'Unified patch is required.' };
  }

  const lines = normalizeLineEndings(diff).replace(/\n$/, '').split('\n');
  const hasGitHeaders = lines.some(line => line.startsWith('diff --git '));
  const starts: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (hasGitHeaders) {
      if (lines[index].startsWith('diff --git ')) starts.push(index);
      continue;
    }

    if (isPlainUnifiedFileHeader(lines, index)) starts.push(index);
  }

  if (!starts.length) {
    return { ok: false, error: 'Unified patch must contain file headers (`diff --git` or `---`/`+++`).' };
  }

  const prefix = lines.slice(0, starts[0]).join('\n').trim();
  if (prefix) return { ok: false, error: 'Unified patch contains non-diff text before the first file header.' };

  const sections: UnifiedDiffFileSection[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? lines.length;
    const sectionLines = lines.slice(start, end);
    const paths = parseFileSectionPaths(sectionLines);
    if (!paths.path) return { ok: false, error: `Unified patch file section ${index + 1} is missing a file path.` };
    sections.push({
      path: paths.path,
      ...(paths.oldPath ? { oldPath: paths.oldPath } : {}),
      ...(paths.newPath ? { newPath: paths.newPath } : {}),
      diff: sectionLines.join('\n'),
    });
  }

  return { ok: true, value: sections };
};

const stripCommentPrefix = (line: string) =>
  line
    .trim()
    .replace(/^(\/\/|#|--|\/\*+|\*\/?|\*)\s*/, '')
    .trim();

const proseInstructionPattern = /^(implementation details|current .+ in order|proposed .+ in order|existing .+ currently|update .+ so|preserve\b|keep\b|move\b|remove\b|add\b|change\b|run\b|implement\b|wire\b|ensure\b|include\b|use\b|replace\b|rename\b|increment\b|after approval\b)/i;

export const isLikelyProseUnifiedDiff = (diff: string | undefined) => {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return false;
  const addedLines = parsed.value.hunks
    .flatMap(hunk => hunk.lines)
    .filter(line => line.kind === 'add')
    .map(line => stripCommentPrefix(line.text))
    .filter(Boolean);
  if (addedLines.length < 2) return false;

  const proseLines = addedLines.filter(line =>
    proseInstructionPattern.test(line)
    || /^[-*]\s+(keep|move|remove|add|change|update|preserve|run|implement|wire|ensure)\b/i.test(line),
  );
  return proseLines.length >= 2 && proseLines.length / addedLines.length >= 0.6;
};

export const applyUnifiedDiff = (content: string, diff: string): UnifiedDiffResult<{
  content: string;
  additions: number;
  deletions: number;
}> => {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return parsed;

  const original = splitContentLines(content);
  const output: string[] = [];
  let originalIndex = 0;

  for (const hunk of parsed.value.hunks) {
    const expectedIndex = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
    if (expectedIndex < originalIndex || expectedIndex > original.lines.length) {
      return { ok: false, error: `Unified diff hunk starts outside the current file at line ${hunk.oldStart}.` };
    }

    output.push(...original.lines.slice(originalIndex, expectedIndex));
    originalIndex = expectedIndex;

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        output.push(line.text);
        continue;
      }

      const currentLine = original.lines[originalIndex];
      if (currentLine !== line.text) {
        return {
          ok: false,
          error: `Unified diff does not apply at line ${originalIndex + 1}.`,
        };
      }

      if (line.kind === 'context') output.push(line.text);
      originalIndex += 1;
    }
  }

  output.push(...original.lines.slice(originalIndex));
  return {
    ok: true,
    value: {
      content: joinContentLines(output, original.trailingNewline, original.lineEnding),
      additions: parsed.value.additions,
      deletions: parsed.value.deletions,
    },
  };
};

export const countUnifiedDiffChanges = (diff: string | undefined) => {
  const parsed = parseUnifiedDiff(diff);
  return parsed.ok ? { additions: parsed.value.additions, deletions: parsed.value.deletions } : { additions: 0, deletions: 0 };
};

export const isMissingPathError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no such file|cannot find|does not exist/i.test(message);
};
