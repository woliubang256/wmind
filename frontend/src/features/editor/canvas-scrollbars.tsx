import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Rect } from '@/editor/layout/types';
import type { Viewport } from '@/editor/viewer/viewer-types';
import { scrollAxis } from './canvas-navigation';

export function CanvasScrollbars({ canvasRef, bounds, viewport, onChange, surfaceId = 'editor-canvas-surface' }: {
  canvasRef: RefObject<HTMLDivElement | null>; bounds: Rect; viewport: Viewport;
  onChange: React.Dispatch<React.SetStateAction<Viewport>>;
  surfaceId?: string;
}) {
  const { t } = useTranslation();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const drag = useRef<{ start: number; offset: number; range: number; travel: number } | null>(null);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasRef]);
  return <>{(['horizontal', 'vertical'] as const).map((direction) => {
    const horizontal = direction === 'horizontal';
    const key = horizontal ? 'x' : 'y';
    const length = horizontal ? size.width : size.height;
    const axis = scrollAxis(bounds[key], horizontal ? bounds.width : bounds.height, length, viewport[key], viewport.zoom);
    const track = Math.max(0, length - 20);
    const thumb = Math.min(track, Math.max(28, track * axis.visible));
    const travel = track - thumb;
    return <div key={direction} data-canvas-scrollbar={direction}
      role="scrollbar" tabIndex={0} aria-label={t(horizontal ? 'editor.scrollHorizontal' : 'editor.scrollVertical')}
      aria-orientation={direction} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(axis.fraction * 100)}
      aria-controls={surfaceId}
      className={`absolute z-10 touch-none rounded bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${horizontal ? 'bottom-0.5 left-1 right-4 h-3 cursor-default' : 'bottom-4 right-0.5 top-1 w-3 cursor-default'}`}
      onPointerDown={(event) => {
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = event.currentTarget.getBoundingClientRect();
        const local = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
        const position = horizontal ? event.clientX : event.clientY;
        const isThumb = (event.target as HTMLElement).hasAttribute('data-scroll-thumb');
        const fraction = travel > 0 ? Math.max(0, Math.min(1, (local - thumb / 2) / travel)) : 0;
        const offset = isThumb ? viewport[key] : -(axis.min + fraction * axis.range);
        if (!isThumb) onChange((prev) => ({ ...prev, [key]: offset }));
        drag.current = { start: position, offset, range: axis.range, travel };
      }}
      onPointerMove={(event) => {
        if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const current = drag.current;
        const delta = (horizontal ? event.clientX : event.clientY) - current.start;
        if (current.travel > 0) onChange((prev) => ({ ...prev, [key]: current.offset - delta / current.travel * current.range }));
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        let offset = viewport[key];
        if (event.key === 'Home') offset = -axis.min;
        else if (event.key === 'End') offset = -(axis.min + axis.range);
        else if (event.key === 'PageUp') offset += length * 0.8;
        else if (event.key === 'PageDown') offset -= length * 0.8;
        else if (event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')) offset += 40;
        else if (event.key === (horizontal ? 'ArrowRight' : 'ArrowDown')) offset -= 40;
        else return;
        event.preventDefault(); event.stopPropagation();
        onChange((prev) => ({ ...prev, [key]: offset }));
      }}>
      <div data-scroll-thumb className="absolute rounded-full bg-muted-foreground/45 hover:bg-muted-foreground/65"
        style={horizontal ? { left: axis.fraction * travel, width: thumb, height: 5, top: 3.5 }
          : { top: axis.fraction * travel, height: thumb, width: 5, left: 3.5 }} />
    </div>;
  })}</>;
}
