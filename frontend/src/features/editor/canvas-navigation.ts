import type { Rect } from '@/editor/layout/types';
import type { Viewport } from '@/editor/viewer/viewer-types';
import type { CanvasView } from '@/editor/model/types';

/** 视口平移均使用屏幕像素；留一屏空白，使小图也能通过滚动条平移。 */
export function scrollAxis(start: number, length: number, size: number, offset: number, zoom: number) {
  const min = Math.min(start * zoom - size, -offset);
  const max = Math.max((start + length) * zoom, -offset + size) + size;
  const total = Math.max(size, max - min);
  const range = Math.max(0, total - size);
  return { min, range, fraction: range ? (-offset - min) / range : 0, visible: size / total };
}

export function centeredViewport(viewport: Viewport, root: Rect, size: { width: number; height: number }): Viewport {
  return { ...viewport, x: size.width / 2 - (root.x + root.width / 2) * viewport.zoom,
    y: size.height / 2 - (root.y + root.height / 2) * viewport.zoom };
}

export function savedCanvasView(viewport: Viewport, size: { width: number; height: number }): CanvasView {
  return { centerX: (size.width / 2 - viewport.x) / viewport.zoom,
    centerY: (size.height / 2 - viewport.y) / viewport.zoom, zoom: viewport.zoom };
}

export function restoredViewport(view: CanvasView, size: { width: number; height: number }): Viewport {
  return { x: size.width / 2 - view.centerX * view.zoom, y: size.height / 2 - view.centerY * view.zoom, zoom: view.zoom };
}

export function fittedViewport(bounds: Rect, size: { width: number; height: number }): Viewport {
  const zoom = Math.max(0.2, Math.min(1.2, Math.min(size.width / Math.max(1, bounds.width), size.height / Math.max(1, bounds.height)) * 0.94));
  return restoredViewport({ centerX: bounds.x + bounds.width / 2, centerY: bounds.y + bounds.height / 2, zoom }, size);
}
