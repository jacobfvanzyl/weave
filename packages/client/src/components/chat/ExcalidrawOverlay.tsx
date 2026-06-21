import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { X } from 'lucide-react';
import { configureExcalidrawAssetPath } from '../../lib/excalidraw-assets';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';
import { ExcalidrawCanvasControls } from '../editor/ExcalidrawCanvasControls';
import { useApplePencilExcalidrawControls } from '../editor/useApplePencilExcalidrawControls';
import { Button } from '../ui/button';

type ExcalidrawOverlayProps = {
  onHide: () => void;
};

type ExcalidrawComponentProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawComponentProps['excalidrawAPI']>>[0];
type ExcalidrawChangeHandler = NonNullable<ExcalidrawComponentProps['onChange']>;
type ExcalidrawSceneSnapshot = Parameters<ExcalidrawChangeHandler>;
type ExcalidrawTopRightRenderer = NonNullable<ExcalidrawComponentProps['renderTopRightUI']>;

const excalidrawUIOptions: ExcalidrawComponentProps['UIOptions'] = {};

export const ExcalidrawOverlay = ({ onHide }: ExcalidrawOverlayProps) => {
  const mode = useThemeStore(state => state.mode);
  const theme = getResolvedTheme(mode);
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const excalidrawSurfaceRef = useRef<HTMLElement | null>(null);
  const sceneSnapshotRef = useRef<ExcalidrawSceneSnapshot | null>(null);
  const isApplePencilHandModeActive = useApplePencilExcalidrawControls(excalidrawApiRef, excalidrawSurfaceRef, true);

  useEffect(() => {
    configureExcalidrawAssetPath();
  }, []);

  const handleExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawApiRef.current = api;
  }, []);

  const handleChange = useCallback<ExcalidrawChangeHandler>((elements, appState, files) => {
    sceneSnapshotRef.current = [elements, appState, files];
  }, []);

  const renderExcalidrawTopRightUI = useCallback<ExcalidrawTopRightRenderer>((_isMobile, appState) => (
    <ExcalidrawCanvasControls apiRef={excalidrawApiRef} appState={appState} />
  ), []);

  return (
    <section
      ref={excalidrawSurfaceRef}
      className="relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background p-0.5"
      data-weave-excalidraw-surface
      data-weave-pencil-active={isApplePencilHandModeActive ? 'true' : undefined}
      data-weave-surface="editor"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3" data-weave-overlay-titlebar>
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">Weave Sketch</h2>
        <Button
          className="ml-auto"
          size="icon"
          variant="ghost"
          aria-label="Close sketch board"
          onClick={onHide}
        >
          <X size={18} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        <Excalidraw
          autoFocus
          excalidrawAPI={handleExcalidrawApi}
          name="Weave Sketch"
          onChange={handleChange}
          renderTopRightUI={renderExcalidrawTopRightUI}
          theme={theme}
          UIOptions={excalidrawUIOptions}
        />
      </div>
    </section>
  );
};
