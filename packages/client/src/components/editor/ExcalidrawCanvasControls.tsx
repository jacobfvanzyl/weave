import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { Grid2X2, Magnet, SlidersHorizontal } from 'lucide-react';
import { useId, type PointerEvent, type RefObject } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

export type ExcalidrawCanvasAppState = {
  gridModeEnabled?: boolean;
  gridSize?: number;
  gridStep?: number;
  objectsSnapModeEnabled?: boolean;
};

type ExcalidrawCanvasSceneAppState = {
  gridModeEnabled: boolean;
  gridSize: number;
  gridStep: number;
  objectsSnapModeEnabled: boolean;
};

type ExcalidrawCanvasApi = {
  getAppState: () => ExcalidrawCanvasAppState;
  updateScene: (sceneData: {
    appState?: ExcalidrawCanvasSceneAppState;
    captureUpdate?: typeof CaptureUpdateAction.NEVER;
  }) => void;
};

type ExcalidrawCanvasControlsProps = {
  apiRef: RefObject<ExcalidrawCanvasApi | null>;
  appState: ExcalidrawCanvasAppState;
  className?: string;
  onAppStateChange?: (appState: ExcalidrawCanvasAppState) => void;
};

const defaultGridSize = 20;
const defaultGridStep = 5;
const gridSizeMinimum = 4;
const gridSizeMaximum = 200;
const gridStepMinimum = 1;
const gridStepMaximum = 20;

const clampInteger = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  const parsedValue = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsedValue)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsedValue)));
};

const getGridSize = (appState: ExcalidrawCanvasAppState) => (
  clampInteger(appState.gridSize, defaultGridSize, gridSizeMinimum, gridSizeMaximum)
);

const getGridStep = (appState: ExcalidrawCanvasAppState) => (
  clampInteger(appState.gridStep, defaultGridStep, gridStepMinimum, gridStepMaximum)
);

const iconButtonClassName = [
  'h-8 w-8 border-border/70 bg-background/92 text-foreground shadow-sm backdrop-blur',
  'data-[active=true]:border-primary/70 data-[active=true]:bg-primary/12 data-[active=true]:text-primary',
].join(' ');

export const ExcalidrawCanvasControls = ({
  apiRef,
  appState,
  className,
  onAppStateChange,
}: ExcalidrawCanvasControlsProps) => {
  const idPrefix = useId();
  const gridModeEnabled = appState.gridModeEnabled === true;
  const objectsSnapModeEnabled = appState.objectsSnapModeEnabled === true;
  const gridSize = getGridSize(appState);
  const gridStep = getGridStep(appState);

  const getCanvasSceneAppState = (state: ExcalidrawCanvasAppState): ExcalidrawCanvasSceneAppState => ({
    gridModeEnabled: state.gridModeEnabled === true,
    gridSize: getGridSize(state),
    gridStep: getGridStep(state),
    objectsSnapModeEnabled: state.objectsSnapModeEnabled === true,
  });

  const applyAppState = (updates: Partial<ExcalidrawCanvasSceneAppState>) => {
    const api = apiRef.current;
    if (!api) return;

    const currentAppState = api.getAppState();
    const nextCanvasAppState = {
      ...getCanvasSceneAppState(currentAppState),
      ...updates,
    };
    const nextAppState = {
      ...currentAppState,
      ...nextCanvasAppState,
    };

    api.updateScene({
      appState: nextCanvasAppState,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    onAppStateChange?.(nextAppState);
  };

  const toggleGrid = () => {
    const nextGridModeEnabled = !gridModeEnabled;
    applyAppState({
      gridModeEnabled: nextGridModeEnabled,
      objectsSnapModeEnabled: nextGridModeEnabled ? false : objectsSnapModeEnabled,
      gridSize,
      gridStep,
    });
  };

  const toggleObjectSnap = () => {
    const nextObjectsSnapModeEnabled = !objectsSnapModeEnabled;
    applyAppState({
      objectsSnapModeEnabled: nextObjectsSnapModeEnabled,
      gridModeEnabled: nextObjectsSnapModeEnabled ? false : gridModeEnabled,
      gridSize,
      gridStep,
    });
  };

  const updateGridSize = (value: unknown) => {
    applyAppState({
      gridSize: clampInteger(value, gridSize, gridSizeMinimum, gridSizeMaximum),
      gridStep,
    });
  };

  const updateGridStep = (value: unknown) => {
    applyAppState({
      gridSize,
      gridStep: clampInteger(value, gridStep, gridStepMinimum, gridStepMaximum),
    });
  };

  const stopControlPointer = (event: PointerEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      className={cn('flex items-center gap-1.5', className)}
      data-weave-excalidraw-controls
      onPointerDown={stopControlPointer}
    >
      <Button
        aria-label={gridModeEnabled ? 'Hide grid' : 'Show grid'}
        aria-pressed={gridModeEnabled}
        className={iconButtonClassName}
        data-active={gridModeEnabled ? 'true' : undefined}
        size="icon-sm"
        title={gridModeEnabled ? 'Hide grid' : 'Show grid'}
        variant="outline"
        onClick={toggleGrid}
      >
        <Grid2X2 size={16} />
      </Button>
      <Button
        aria-label={objectsSnapModeEnabled ? 'Disable object snapping' : 'Enable object snapping'}
        aria-pressed={objectsSnapModeEnabled}
        className={iconButtonClassName}
        data-active={objectsSnapModeEnabled ? 'true' : undefined}
        size="icon-sm"
        title={objectsSnapModeEnabled ? 'Disable object snapping' : 'Enable object snapping'}
        variant="outline"
        onClick={toggleObjectSnap}
      >
        <Magnet size={16} />
      </Button>
      <Popover>
        <PopoverTrigger
          render={(
            <Button
              aria-label="Grid settings"
              className={iconButtonClassName}
              size="icon-sm"
              title="Grid settings"
              variant="outline"
            >
              <SlidersHorizontal size={16} />
            </Button>
          )}
        />
        <PopoverContent
          align="end"
          className="w-52"
          side="bottom"
          sideOffset={8}
          onPointerDown={stopControlPointer}
        >
          <div className="grid gap-3 text-xs text-foreground">
            <label className="grid gap-1.5" htmlFor={`${idPrefix}-grid-size`}>
              <span className="font-medium">Grid size</span>
              <Input
                nativeInput
                id={`${idPrefix}-grid-size`}
                inputMode="numeric"
                max={gridSizeMaximum}
                min={gridSizeMinimum}
                size="sm"
                type="number"
                value={gridSize}
                onChange={event => updateGridSize(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1.5" htmlFor={`${idPrefix}-grid-step`}>
              <span className="font-medium">Major step</span>
              <Input
                nativeInput
                id={`${idPrefix}-grid-step`}
                inputMode="numeric"
                max={gridStepMaximum}
                min={gridStepMinimum}
                size="sm"
                type="number"
                value={gridStep}
                onChange={event => updateGridStep(event.currentTarget.value)}
              />
            </label>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
