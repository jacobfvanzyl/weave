import { useEffect, useRef, useState } from 'react';

export const chatContentMaxWidthPx = 48 * 16;
export const threadSidebarWidthPx = 24 * 16;
export const minimumMainEditorColumns = 80;
export const defaultMinimumMainEditorWidthPx = minimumMainEditorColumns * 8;
export const editorColumnMeasureText = '0'.repeat(minimumMainEditorColumns);

export const isPortraitViewportNow = () => window.innerHeight > window.innerWidth;

export const useIsPortraitViewport = () => {
  const [isPortraitViewport, setIsPortraitViewport] = useState(() => isPortraitViewportNow());

  useEffect(() => {
    const sync = () => setIsPortraitViewport(isPortraitViewportNow());

    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  return isPortraitViewport;
};

export const useMeasuredElementWidth = <T extends HTMLElement = HTMLDivElement>(
  initialWidth = typeof window === 'undefined' ? 0 : window.innerWidth,
) => {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initialWidth);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const updateWidth = () => setWidth(element.getBoundingClientRect().width);
    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  return [ref, width] as const;
};

export const useMainPaneMetrics = () => {
  const [pageRef, pageWidth] = useMeasuredElementWidth();
  const [editorMinimumMeasureRef, editorMinimumWidthPx] = useMeasuredElementWidth<HTMLSpanElement>(defaultMinimumMainEditorWidthPx);

  return {
    editorMinimumMeasureRef,
    editorMinimumWidthPx,
    pageRef,
    pageWidth,
  };
};
