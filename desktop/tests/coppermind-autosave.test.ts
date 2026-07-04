import { describe, expect, it } from 'vitest';
import {
  applyCoppermindAutosaveResult,
  createCoppermindAutosaveSnapshot,
  doesCoppermindWatchEventTouchPath,
  getCoppermindAutosaveWatchDirectories,
  isCoppermindAutosaveStaleVersionError,
  shouldAutosaveCoppermindBuffer,
} from '../../packages/client/src/lib/coppermind-autosave';

describe('coppermind autosave helpers', () => {
  it('only schedules dirty Coppermind documents', () => {
    expect(shouldAutosaveCoppermindBuffer({
      path: 'Notebook.cpr',
      content: 'old',
      value: 'new',
    })).toBe(true);
    expect(shouldAutosaveCoppermindBuffer({
      path: 'Notebook.cpr',
      content: 'same',
      value: 'same',
    })).toBe(false);
    expect(shouldAutosaveCoppermindBuffer({
      path: 'note.md',
      content: 'old',
      value: 'new',
    })).toBe(false);
    expect(shouldAutosaveCoppermindBuffer({
      path: 'Notebook.cpr',
      content: 'old',
      value: 'new',
    }, true)).toBe(false);
  });

  it('updates the saved baseline after a successful write', () => {
    const buffer = {
      path: 'Notebook.cpr',
      content: 'old',
      value: 'new',
      version: 'v1',
      dirty: true,
    };
    const snapshot = createCoppermindAutosaveSnapshot(buffer);
    const next = applyCoppermindAutosaveResult(buffer, snapshot, {
      path: 'Notebook.cpr',
      version: 'v2',
      size: 3,
      mtimeMs: 10,
    });

    expect(next).toMatchObject({
      content: 'new',
      value: 'new',
      version: 'v2',
      size: 3,
      mtimeMs: 10,
      dirty: false,
    });
  });

  it('keeps newer local edits dirty when an older in-flight snapshot completes', () => {
    const snapshot = {
      path: 'Notebook.cpr',
      value: 'first edit',
      version: 'v1',
    };
    const currentBuffer = {
      path: 'Notebook.cpr',
      content: 'old',
      value: 'second edit',
      version: 'v1',
      dirty: true,
    };
    const next = applyCoppermindAutosaveResult(currentBuffer, snapshot, {
      path: 'Notebook.cpr',
      version: 'v2',
    });

    expect(next.content).toBe('first edit');
    expect(next.value).toBe('second edit');
    expect(next.version).toBe('v2');
    expect(next.dirty).toBe(true);
  });

  it('recognizes stale-version save failures', () => {
    expect(isCoppermindAutosaveStaleVersionError(new Error('File changed on disk. Reload before saving.'))).toBe(true);
    expect(isCoppermindAutosaveStaleVersionError(new Error('Network unavailable'))).toBe(false);
  });

  it('watches Coppermind parent directories and filters events by file path', () => {
    expect(getCoppermindAutosaveWatchDirectories([
      'Notebook.cpr',
      'Folder/Research.cpr',
      'Folder/note.md',
    ])).toEqual(['', 'Folder']);

    expect(doesCoppermindWatchEventTouchPath({
      paths: ['Folder/Research.cpr'],
      affectedDirectories: ['Folder'],
    }, 'Folder/Research.cpr')).toBe(true);
    expect(doesCoppermindWatchEventTouchPath({
      paths: ['Folder/note.md'],
      affectedDirectories: ['Folder'],
    }, 'Folder/Research.cpr')).toBe(false);
    expect(doesCoppermindWatchEventTouchPath({
      paths: [],
      affectedDirectories: ['Folder'],
      rescan: true,
    }, 'Folder/Research.cpr')).toBe(true);
  });
});
