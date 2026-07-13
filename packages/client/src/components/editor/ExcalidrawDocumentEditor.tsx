import { type ComponentProps, type CSSProperties, useCallback, useEffect, useMemo, useRef } from 'react';
import { CaptureUpdateAction, Excalidraw, restore as restoreExcalidrawData, serializeAsJSON as serializeExcalidrawAsJSON, } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { editorCanvasBackgroundColor } from './CodeMirrorEditor';
import { type ExcalidrawCanvasAppState, ExcalidrawCanvasControls } from './ExcalidrawCanvasControls';
import { ExcalidrawPencilToolOverlay } from './ExcalidrawPencilToolOverlay';
import { configureExcalidrawAssetPath } from '../../lib/excalidraw-assets';
import { useApplePencilExcalidrawControls } from './useApplePencilExcalidrawControls';

type ExcalidrawComponentProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawComponentProps['excalidrawAPI']>>[0];
type ExcalidrawChangeHandler = NonNullable<ExcalidrawComponentProps['onChange']>;
type ExcalidrawTopRightRenderer = NonNullable<ExcalidrawComponentProps['renderTopRightUI']>;
type RestoredExcalidrawData = ReturnType<typeof restoreExcalidrawData>;

export type ExcalidrawDocumentEditorProps = {
  focusRequest?: number;
  isExpanded: boolean;
  path: string;
  theme: 'light' | 'dark';
  value: string;
  version: string;
  viewState?: { scrollX: number; scrollY: number; zoom: number };
  onChange: (value: string) => void;
  onViewStateChange?: (viewState: { scrollX: number; scrollY: number; zoom: number }) => void;
};

const excalidrawDarkFilteredEditorBackgroundColor = '#eeeeff';

const isDefaultExcalidrawBackground = (value: unknown) => {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return ( !normalized || normalized === '#fff' || normalized === '#ffffff' || normalized === 'white' || normalized === 'transparent'
  );
};

const getExcalidrawAppStateWithEditorBackground = (appState: unknown) => {
  const appStateRecord = appState && typeof appState === 'object'
    ? { ...(appState as Record<string, unknown>) }
    : {};
  const hasStoredBackground = Object.prototype.hasOwnProperty.call(appStateRecord, 'viewBackgroundColor');
  if (!hasStoredBackground || isDefaultExcalidrawBackground(appStateRecord.viewBackgroundColor)) {
    appStateRecord.viewBackgroundColor = editorCanvasBackgroundColor;
  }
  return appStateRecord;
};

const isEditorCanvasBackground = (value: unknown) =>
  typeof value === 'string' && value.trim().toLowerCase() === editorCanvasBackgroundColor;

const isDarkFilteredEditorCanvasBackground = (value: unknown) =>
  typeof value === 'string' && value.trim().toLowerCase() === excalidrawDarkFilteredEditorBackgroundColor;

const getExcalidrawRuntimeAppState = (appState: RestoredExcalidrawData['appState'], theme: 'light' | 'dark') => {
  const runtimeAppState = { ...appState };
  if (theme === 'dark' && isEditorCanvasBackground(runtimeAppState.viewBackgroundColor)) {
    runtimeAppState.viewBackgroundColor = excalidrawDarkFilteredEditorBackgroundColor;
  }
  return runtimeAppState;
};

const getExcalidrawStoredAppState = (appState: Parameters<typeof serializeExcalidrawAsJSON>[1]) => {
  const storedAppState = { ...appState };
  if (isDarkFilteredEditorCanvasBackground(storedAppState.viewBackgroundColor)) {
    storedAppState.viewBackgroundColor = editorCanvasBackgroundColor;
  }
  return storedAppState;
};

export const createEmptyExcalidrawFile = () => serializeExcalidrawAsJSON(
  [],
  { viewBackgroundColor: editorCanvasBackgroundColor },
  {},
  'local'
);

const parseExcalidrawStoredData = (content: string): RestoredExcalidrawData => {
  try {
    const parsed = content ? ( JSON.parse(content) as Record<string, unknown>) : {};
    const elements = Array.isArray(parsed.elements) ? ( parsed.elements as any) : [];
    return restoreExcalidrawData(
      {
        elements,
        appState: getExcalidrawAppStateWithEditorBackground(parsed.appState) as any,
        files: parsed.files && typeof parsed.files === 'object' ? ( parsed.files as any) : {},
      },
      { viewBackgroundColor: editorCanvasBackgroundColor },
      null,
    );
  } catch {
    return restoreExcalidrawData(
      { elements: [], appState: { viewBackgroundColor: editorCanvasBackgroundColor }, files: {}, },
      { viewBackgroundColor: editorCanvasBackgroundColor },
      null,
    );
  }
};

const parseExcalidrawInitialData = (content: string, theme: 'light' | 'dark'): RestoredExcalidrawData => {
  const storedData = parseExcalidrawStoredData(content);
  return {
    ...storedData,
    appState: getExcalidrawRuntimeAppState(storedData.appState, theme),
  };
};

const serializeExcalidrawScene = ([elements, appState, files]: Parameters<ExcalidrawChangeHandler>) =>
  serializeExcalidrawAsJSON(elements, getExcalidrawStoredAppState(appState), files, 'local');

const serializeRestoredExcalidrawData = (data: RestoredExcalidrawData) =>
  serializeExcalidrawAsJSON(data.elements, getExcalidrawStoredAppState(data.appState), data.files, 'local'
);

export function normalizeExcalidrawContent(content: string) {
  return serializeRestoredExcalidrawData(parseExcalidrawStoredData(content));
}

export const ExcalidrawDocumentEditor = ({
  focusRequest = 0,
  isExpanded,
  path,
  theme,
  value,
  version,
  viewState,
  onChange,
  onViewStateChange,
}: ExcalidrawDocumentEditorProps) => {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const skippedInitialChangeKeyRef = useRef<string | undefined>(undefined);
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const resizeTimeoutRef = useRef<number | undefined>(undefined);
  const viewSaveTimeoutRef = useRef<number | undefined>(undefined);
  const pendingViewStateRef = useRef<{ scrollX: number; scrollY: number; zoom: number } | undefined>(undefined);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const bufferKey = `${path}:${version}`;

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  const flushViewState = useCallback(() => {
    if (viewSaveTimeoutRef.current !== undefined) {
      window.clearTimeout(viewSaveTimeoutRef.current);
      viewSaveTimeoutRef.current = undefined;
    }
    const pendingViewState = pendingViewStateRef.current;
    if (!pendingViewState) return;
    pendingViewStateRef.current = undefined;
    onViewStateChangeRef.current?.(pendingViewState);
  }, []);

  const scheduleResize = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (resizeFrameRef.current !== undefined) { window.cancelAnimationFrame(resizeFrameRef.current);
    }
    if (resizeTimeoutRef.current !== undefined) { window.clearTimeout(resizeTimeoutRef.current);
    }

    const notifyResize = () => window.dispatchEvent(new Event('resize'));
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      notifyResize();
    });
    resizeTimeoutRef.current = window.setTimeout(() => {
      resizeTimeoutRef.current = undefined;
      notifyResize();
    }, 180);
  }, []);

  const initialData = useMemo(() => parseExcalidrawInitialData(value, theme), [value, version, theme]);
  const initialSerialized = useMemo(() => serializeRestoredExcalidrawData(initialData), [initialData]);
  const viewBackgroundColor = initialData.appState.viewBackgroundColor ?? editorCanvasBackgroundColor;
  const applePencilControls = useApplePencilExcalidrawControls(apiRef, surfaceRef, true);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
      if (viewState) {
        api.updateScene({
          appState: {
            scrollX: viewState.scrollX,
            scrollY: viewState.scrollY,
            zoom: { value: viewState.zoom },
          } as any,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    scheduleResize();
  }, [scheduleResize, viewState],);

  const handleChange = useCallback((...snapshot: Parameters<ExcalidrawChangeHandler>) => {
      const appState = snapshot[1] as unknown as Record<string, unknown>;
      if (onViewStateChangeRef.current) {
        if (viewSaveTimeoutRef.current !== undefined) {
          window.clearTimeout(viewSaveTimeoutRef.current);
        }
        const zoom =
          appState.zoom && typeof appState.zoom === 'object'
            ? (appState.zoom as Record<string, unknown>).value
            : appState.zoom;
        pendingViewStateRef.current = {
          scrollX: typeof appState.scrollX === 'number' ? appState.scrollX : 0,
          scrollY: typeof appState.scrollY === 'number' ? appState.scrollY : 0,
          zoom: typeof zoom === 'number' ? zoom : 1,
        };
        viewSaveTimeoutRef.current = window.setTimeout(flushViewState, 250);
      }
    const serializedScene = serializeExcalidrawScene(snapshot);
    if (skippedInitialChangeKeyRef.current !== bufferKey) {
      skippedInitialChangeKeyRef.current = bufferKey;
      if (serializedScene === initialSerialized) return;
    }
    onChange(serializedScene);
  }, [bufferKey, flushViewState, initialSerialized, onChange],);

  const handleAppStateChange = useCallback((appState: ExcalidrawCanvasAppState) => {
    const api = apiRef.current;
    if (!api) return;

    const serializedScene = serializeExcalidrawAsJSON(
      api.getSceneElementsIncludingDeleted(),
      getExcalidrawStoredAppState(appState as Parameters<typeof serializeExcalidrawAsJSON>[1]),
      api.getFiles(),
      'local',
    );
    onChange(serializedScene);
  }, [onChange],);

  const renderTopRightUI = useCallback<ExcalidrawTopRightRenderer>((_isMobile, appState) => (
    <ExcalidrawCanvasControls
      apiRef={apiRef}
      appState={appState}
      onAppStateChange={handleAppStateChange}
    />
  ), [handleAppStateChange],);

  useEffect(() => {
    configureExcalidrawAssetPath();
  }, []);

  useEffect(() => {
    apiRef.current?.updateScene({
      appState: { viewBackgroundColor },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [bufferKey, viewBackgroundColor]);

  useEffect(() => {
    scheduleResize();
  }, [isExpanded, path, scheduleResize]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushViewState();
    };
    window.addEventListener('pagehide', flushViewState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushViewState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushViewState]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const fallbackTarget = surfaceRef.current;
      const focusTarget = fallbackTarget?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input, canvas, .excalidraw') ?? fallbackTarget;
      focusTarget?.focus({ preventScroll: true });
      scheduleResize();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusRequest, scheduleResize]);

  useEffect(() => () => {
    if (typeof window === 'undefined') return;
    if (resizeFrameRef.current !== undefined) { window.cancelAnimationFrame(resizeFrameRef.current);
      }
    if (resizeTimeoutRef.current !== undefined) { window.clearTimeout(resizeTimeoutRef.current);
  }
      if (viewSaveTimeoutRef.current !== undefined) {
        window.clearTimeout(viewSaveTimeoutRef.current);
      }
      flushViewState();
    }, [flushViewState],);

  return (
    <div
      ref={surfaceRef}
      className="relative h-full w-full"
      data-weave-editor-excalidraw
      data-weave-pencil-input-active={applePencilControls.isPencilInputActive ? 'true' : undefined}
      data-weave-pencil-active={applePencilControls.isPencilChromeHidden ? 'true' : undefined}
      style={{ '--weave-excalidraw-background': editorCanvasBackgroundColor, } as CSSProperties}
    >
      <Excalidraw
        autoFocus
        excalidrawAPI={handleApi}
        key={bufferKey}
        initialData={initialData}
        name={path}
        onChange={handleChange}
        renderTopRightUI={renderTopRightUI}
        theme={theme}
      />
      <ExcalidrawPencilToolOverlay
        overlay={applePencilControls.toolOverlay}
        onSelectTool={applePencilControls.selectTool}
      />
    </div>
  );
};
