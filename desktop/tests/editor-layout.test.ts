import { describe, expect, it } from 'vitest';
import {
  defaultMainEditorMinimumWidthPx,
  editorContentWidthCss,
  editorExplorerWidthPx,
  getTwoColumnPaneLayout,
  minimumMainEditorColumns,
} from '../../packages/client/src/lib/editor-layout';

describe('editor layout', () => {
  it('reserves the measured 80-column editor width before allocating chat space', () => {
    expect(minimumMainEditorColumns).toBe(80);
    expect(editorContentWidthCss).toBe('calc(80ch + 24px)');
    expect(defaultMainEditorMinimumWidthPx).toBe(711);
  });

  it('reserves the pinned Explorer when Chat and the 80-column Editor both fit', () => {
    expect(editorExplorerWidthPx).toBe(320);
    expect(getTwoColumnPaneLayout({
      availableWidthPx: 2_000,
      chatMinimumWidthPx: 768,
      editorMinimumWidthPx: 640,
      isExplorerPinned: true,
    })).toEqual({
      chatWidthPx: 1_039,
      editorReservedWidthPx: 960,
      shouldForceExplorerHoverOnly: false,
    });
  });

  it('makes Explorer hover-only before shrinking the Editor', () => {
    expect(getTwoColumnPaneLayout({
      availableWidthPx: 1_600,
      chatMinimumWidthPx: 768,
      editorMinimumWidthPx: 640,
      isExplorerPinned: true,
    })).toEqual({
      chatWidthPx: 959,
      editorReservedWidthPx: 640,
      shouldForceExplorerHoverOnly: true,
    });
  });

  it('keeps the Chat minimum and shrinks the Editor when both minimums cannot fit', () => {
    expect(getTwoColumnPaneLayout({
      availableWidthPx: 1_200,
      chatMinimumWidthPx: 768,
      editorMinimumWidthPx: 640,
      isExplorerPinned: true,
    })).toEqual({
      chatWidthPx: 768,
      editorReservedWidthPx: 431,
      shouldForceExplorerHoverOnly: true,
    });
  });

  it('only shrinks Chat when the viewport itself is narrower than its minimum', () => {
    expect(getTwoColumnPaneLayout({
      availableWidthPx: 700,
      chatMinimumWidthPx: 768,
      editorMinimumWidthPx: 640,
      isExplorerPinned: true,
    })).toEqual({
      chatWidthPx: 699,
      editorReservedWidthPx: 0,
      shouldForceExplorerHoverOnly: true,
    });
  });

  it('does not force an already unpinned Explorer into a different state', () => {
    expect(getTwoColumnPaneLayout({
      availableWidthPx: 1_200,
      chatMinimumWidthPx: 768,
      editorMinimumWidthPx: 640,
      isExplorerPinned: false,
    })).toEqual({
      chatWidthPx: 768,
      editorReservedWidthPx: 431,
      shouldForceExplorerHoverOnly: false,
    });
  });
});
