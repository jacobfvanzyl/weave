export const minimumMainEditorColumns = 80;
export const defaultEditorColumnWidthPx = 8;
export const defaultEditorGutterWidthPx = 47;
export const editorLineHorizontalPaddingPx = 12;
export const editorExplorerWidthPx = 20 * 16;
export const mainPaneDividerWidthPx = 1;
export const editorTextWidthCss = `${minimumMainEditorColumns}ch`;
export const editorContentWidthCss = `calc(${editorTextWidthCss} + ${editorLineHorizontalPaddingPx * 2}px)`;
export const defaultMainEditorMinimumWidthPx =
  minimumMainEditorColumns * defaultEditorColumnWidthPx
  + defaultEditorGutterWidthPx
  + editorLineHorizontalPaddingPx * 2;

type TwoColumnPaneLayoutInput = {
  availableWidthPx: number;
  chatMinimumWidthPx: number;
  editorMinimumWidthPx: number;
  isExplorerPinned: boolean;
};

export const getTwoColumnPaneLayout = ({
  availableWidthPx,
  chatMinimumWidthPx,
  editorMinimumWidthPx,
  isExplorerPinned,
}: TwoColumnPaneLayoutInput) => {
  const availableWidth = Math.max(0, availableWidthPx);
  const chatMinimumWidth = Math.max(0, chatMinimumWidthPx);
  const editorMinimumWidth = Math.max(0, editorMinimumWidthPx);
  const editorWidthKeepingChatMinimum = Math.max(
    0,
    availableWidth - mainPaneDividerWidthPx - chatMinimumWidth,
  );
  const canFitEditorMinimum = editorWidthKeepingChatMinimum >= editorMinimumWidth;
  const canFitPinnedExplorer = isExplorerPinned
    && editorWidthKeepingChatMinimum >= editorMinimumWidth + editorExplorerWidthPx;
  const editorReservedWidthPx = canFitPinnedExplorer
    ? editorMinimumWidth + editorExplorerWidthPx
    : canFitEditorMinimum
      ? editorMinimumWidth
      : editorWidthKeepingChatMinimum;

  return {
    chatWidthPx: Math.max(0, availableWidth - mainPaneDividerWidthPx - editorReservedWidthPx),
    editorReservedWidthPx,
    shouldForceExplorerHoverOnly: isExplorerPinned && !canFitPinnedExplorer,
  };
};
