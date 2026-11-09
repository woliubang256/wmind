/**
 * 平移与缩放插件。
 *
 * 只读分享页也挂这个（docs/08 §4.1：分享页只传「平移缩放 + 折叠」），
 * 因此它不能依赖任何编辑态的东西。
 *
 * 交互约定：
 * - `Ctrl/⌘ + 滚轮` 缩放（以光标为锚点）
 * - 滚轮 / 触控板双指平移
 * - `Shift + 滚轮` 横向平移
 * - `Space + 拖拽` 或中键拖拽平移
 * - 触摸空白单指平移，双指以中点缩放和平移
 *
 * 为什么缩放要以光标为锚点：如果按视口中心缩放，用户想放大的位置会飘走，
 * 得再平移一次才能找回焦点，连续缩放时体验极差。
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';
import { canvasGestures, forgetCanvasGestures, MAX_ZOOM, MIN_ZOOM, shouldSuppressCanvasClick, type GestureChange } from './canvas-gestures';

export { MIN_ZOOM, MAX_ZOOM } from './canvas-gestures';

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function PanZoomPlugin() {
  const { svgRef, sheet, readOnly } = useViewer();
  const latest = useLatest(useViewer());
  const spaceDown = useRef(false);

  // The SVG is reused across sheets and preview mode; old pointers must not edit the next view.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg) canvasGestures(svg).cancelNavigation?.();
  }, [svgRef, sheet.id, readOnly]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const runtime = canvasGestures(svg);
    let changingCapture = false;

    const localPoint = (clientX: number, clientY: number) => {
      const rect = svg.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    /** 以 (px, py)（相对 svg 左上角）为锚点缩放。 */
    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      const point = localPoint(clientX, clientY);
      latest.current.setViewport((prev) => {
        const zoom = clampZoom(prev.zoom * factor);
        if (zoom === prev.zoom) return prev;
        // 保持光标下的画布坐标不动：world = (point - translate) / zoom
        const worldX = (point.x - prev.x) / prev.zoom;
        const worldY = (point.y - prev.y) / prev.zoom;
        return { zoom, x: point.x - worldX * zoom, y: point.y - worldY * zoom };
      });
    };

    const onWheel = (event: WheelEvent) => {
      // 画布吞掉所有滚轮事件：否则页面会在导图里滚动，用户以为画布卡住了。
      event.preventDefault();

      // deltaMode === 1 表示以「行」为单位（部分 Firefox / 鼠标驱动），
      // 不换算的话缩放速度会差一个数量级。
      const scale = event.deltaMode === 1 ? 16 : 1;
      const dx = event.deltaX * scale;
      const dy = event.deltaY * scale;

      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-dy * 0.0015), event.clientX, event.clientY);
        return;
      }
      if (event.shiftKey) {
        latest.current.setViewport((prev) => ({ ...prev, x: prev.x - dy }));
        return;
      }
      latest.current.setViewport((prev) => ({ ...prev, x: prev.x - dx, y: prev.y - dy }));
    };

    const cursor = () => { svg.style.cursor = runtime.tracker.active ? 'grabbing' : spaceDown.current ? 'grab' : ''; };
    const apply = (change: GestureChange, event?: PointerEvent) => {
      changingCapture = true;
      try {
        if (change.cancelEditing) for (const cancel of [...runtime.cancelListeners]) cancel();
        for (const id of change.capture ?? []) {
          // A pointer can have been cancelled by the browser between queued events.
          try { svg.setPointerCapture(id); } catch { /* no live pointer to capture */ }
        }
        for (const id of change.release ?? []) {
          if (svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
        }
      } finally { changingCapture = false; }
      if (change.transform) latest.current.setViewport(change.transform);
      cursor();
      if (change.claimed && event) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const cancelGesture = () => apply(runtime.tracker.cancel());
    runtime.cancelNavigation = cancelGesture;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      const target = event.target instanceof Element ? event.target : null;
      const blank = !target?.closest('[data-topic-id], [data-summary-id], [data-relationship-id], [data-routing-relationship-id], [data-boundary-id], [data-collapse-toggle], [data-topic-content-kind]');
      const readOnlySurface = latest.current.readOnly && !target?.closest('[data-collapse-toggle], [data-topic-content-kind]');
      apply(runtime.tracker.down({
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        point: localPoint(event.clientX, event.clientY),
        canPan: blank || readOnlySurface,
        forcePan: event.button === 1 || (event.button === 0 && spaceDown.current),
      }), event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (runtime.tracker.hasPointer(event.pointerId)) apply(runtime.tracker.move(event.pointerId, localPoint(event.clientX, event.clientY)), event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (runtime.tracker.hasPointer(event.pointerId)) apply(runtime.tracker.up(event.pointerId), event);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (runtime.tracker.hasPointer(event.pointerId)) apply(runtime.tracker.cancel(), event);
    };
    const onLostCapture = (event: PointerEvent) => {
      if (!changingCapture && runtime.tracker.hasPointer(event.pointerId) && !svg.hasPointerCapture(event.pointerId)) cancelGesture();
    };
    const onClick = (event: MouseEvent) => {
      if (!shouldSuppressCanvasClick(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && runtime.tracker.active) {
        event.preventDefault(); cancelGesture(); return;
      }
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      // 空格默认会滚动页面，必须拦掉。
      event.preventDefault();
      if (!spaceDown.current) {
        spaceDown.current = true;
        cursor();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceDown.current = false;
      cursor();
    };

    // 失焦时清掉空格状态：切换窗口时 keyup 收不到，否则会一直处于「抓手」态。
    const onBlur = () => {
      spaceDown.current = false;
      cancelGesture();
    };

    // wheel 必须显式 passive: false 才能 preventDefault。
    svg.addEventListener('wheel', onWheel, { passive: false });
    // Navigation takes ownership before topic/relationship editing listeners.
    svg.addEventListener('pointerdown', onPointerDown, true);
    // Relationships finish on window capture and stop propagation; bookkeeping runs first.
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    svg.addEventListener('lostpointercapture', onLostCapture);
    svg.addEventListener('click', onClick, true);
    svg.addEventListener('dblclick', onClick, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      svg.removeEventListener('wheel', onWheel);
      cancelGesture();
      runtime.cancelNavigation = undefined;
      forgetCanvasGestures(svg);
      svg.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      svg.removeEventListener('lostpointercapture', onLostCapture);
      svg.removeEventListener('click', onClick, true);
      svg.removeEventListener('dblclick', onClick, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [svgRef, latest]);

  return null;
}

/**
 * 计算缩放后的视口。工具栏按钮与滚轮缩放共用这一份数学，
 * 避免「按钮缩放不以光标为锚点、滚轮以光标为锚点」的不一致。
 */
export function zoomedViewport(
  prev: { x: number; y: number; zoom: number },
  factor: number,
  anchor?: { x: number; y: number },
): { x: number; y: number; zoom: number } {
  const zoom = clampZoom(prev.zoom * factor);
  if (zoom === prev.zoom) return prev;
  if (!anchor) return { ...prev, zoom };
  const worldX = (anchor.x - prev.x) / prev.zoom;
  const worldY = (anchor.y - prev.y) / prev.zoom;
  return { zoom, x: anchor.x - worldX * zoom, y: anchor.y - worldY * zoom };
}
