import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { CanvasView } from '@/editor/model/types';
import type { Rect } from '@/editor/layout/types';
import type { Viewport } from '@/editor/viewer/viewer-types';
import { fittedViewport, restoredViewport, savedCanvasView } from './canvas-navigation';

/** 作者和访客共用同一套视角，只有作者宿主提供 onSave。自动布局与 resize 不写文档。 */
export function useCanvasViewport(options: {
  canvasRef: RefObject<HTMLDivElement | null>;
  sheetId: string;
  bounds: Rect;
  savedView?: CanvasView;
  ready: boolean;
  surfaceKey?: string;
  resetKey?: number;
  onSave?(sheetId: string, view: CanvasView): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [viewport, applyViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const current = useRef(viewport);
  const size = useRef({ width: 0, height: 0 });
  const localViews = useRef(new Map<string, CanvasView>());
  const lastResetKey = useRef(options.resetKey);
  const apply = useCallback((next: Viewport) => { current.current = next; applyViewport(next); }, []);

  const setViewport: Dispatch<SetStateAction<Viewport>> = useCallback((next) => {
    const value = typeof next === 'function' ? next(current.current) : next;
    if (value === current.current) return;
    apply(value);
    if (!size.current.width || !size.current.height) return;
    const view = savedCanvasView(value, size.current);
    localViews.current.set(latest.current.sheetId, view);
    latest.current.onSave?.(latest.current.sheetId, view);
  }, [apply]);

  const fit = useCallback(() => {
    if (!size.current.width || !size.current.height) return;
    setViewport(fittedViewport(latest.current.bounds, size.current));
  }, [setViewport]);

  useLayoutEffect(() => {
    if (lastResetKey.current !== options.resetKey) {
      localViews.current.clear();
      lastResetKey.current = options.resetKey;
    }
    const element = options.canvasRef.current;
    if (!options.ready || !element) return;
    const initialSize = { width: element.clientWidth, height: element.clientHeight };
    if (!initialSize.width || !initialSize.height) return;
    size.current = initialSize;
    const view = localViews.current.get(options.sheetId) ?? latest.current.savedView;
    apply(view ? restoredViewport(view, initialSize) : fittedViewport(latest.current.bounds, initialSize));
    const observer = new ResizeObserver(() => {
      const nextSize = { width: element.clientWidth, height: element.clientHeight };
      if (!nextSize.width || !nextSize.height || (nextSize.width === size.current.width && nextSize.height === size.current.height)) return;
      const center = savedCanvasView(current.current, size.current);
      size.current = nextSize;
      apply(restoredViewport(center, nextSize));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [options.canvasRef, options.ready, options.sheetId, options.surfaceKey, options.resetKey, apply]);

  return { viewport, setViewport, fit };
}
