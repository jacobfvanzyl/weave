import {
  ArrowUpRight,
  Circle,
  Diamond,
  Eraser,
  Hand,
  Minus,
  MousePointer2,
  PenLine,
  Square,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import type { ExcalidrawPencilTool, ExcalidrawPencilToolOverlayState } from './useApplePencilExcalidrawControls';

type PencilToolDescriptor = {
  icon: LucideIcon;
  label: string;
  tool: ExcalidrawPencilTool;
};

type ExcalidrawPencilToolOverlayProps = {
  onSelectTool: (tool: ExcalidrawPencilTool) => void;
  overlay: ExcalidrawPencilToolOverlayState | null;
};

const pencilTools: PencilToolDescriptor[] = [
  { tool: 'selection', label: 'Selection', icon: MousePointer2 },
  { tool: 'freedraw', label: 'Draw', icon: PenLine },
  { tool: 'eraser', label: 'Eraser', icon: Eraser },
  { tool: 'hand', label: 'Hand', icon: Hand },
  { tool: 'text', label: 'Text', icon: Type },
  { tool: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { tool: 'line', label: 'Line', icon: Minus },
  { tool: 'rectangle', label: 'Rectangle', icon: Square },
  { tool: 'diamond', label: 'Diamond', icon: Diamond },
  { tool: 'ellipse', label: 'Ellipse', icon: Circle },
];

const paletteSize = 184;
const buttonSize = 38;
const toolRadius = 66;

const toolButtonClassName = [
  'absolute size-[38px] rounded-full border-border/70 bg-background/95 text-foreground shadow-md backdrop-blur',
  'data-[active=true]:border-primary/70 data-[active=true]:bg-primary/12 data-[active=true]:text-primary',
].join(' ');

const stopOverlayPointer = (event: PointerEvent) => {
  event.stopPropagation();
};

export const ExcalidrawPencilToolOverlay = ({
  onSelectTool,
  overlay,
}: ExcalidrawPencilToolOverlayProps) => {
  if (!overlay) return null;

  const overlayContent = (
    <div
      aria-label="Apple Pencil tools"
      className="fixed z-50 rounded-full border border-border/70 bg-background/88 shadow-2xl backdrop-blur"
      data-weave-excalidraw-pencil-tool-overlay
      role="toolbar"
      style={{ height: paletteSize, left: overlay.left, top: overlay.top, width: paletteSize }}
      onPointerDown={stopOverlayPointer}
      onPointerMove={stopOverlayPointer}
      onPointerUp={stopOverlayPointer}
    >
      <div className="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/55 bg-primary/18 shadow-sm" />
      {pencilTools.map(({ icon: Icon, label, tool }, index) => {
        const isActive = overlay.activeTool === tool;
        const angle = -Math.PI / 2 + (index / pencilTools.length) * Math.PI * 2;
        const x = paletteSize / 2 + Math.cos(angle) * toolRadius - buttonSize / 2;
        const y = paletteSize / 2 + Math.sin(angle) * toolRadius - buttonSize / 2;

        return (
          <Button
            key={tool}
            aria-label={label}
            aria-pressed={isActive}
            className={cn(toolButtonClassName)}
            data-active={isActive ? 'true' : undefined}
            style={{ left: x, top: y }}
            size="icon"
            title={label}
            variant="outline"
            onClick={() => onSelectTool(tool)}
          >
            <Icon size={18} />
          </Button>
        );
      })}
    </div>
  );

  return createPortal(overlayContent, document.body);
};
