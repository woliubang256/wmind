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
 *
 * 为什么缩放要以光标为锚点：如果按视口中心缩放，用户想放大的位置会飘走，
 * 得再平移一次才能找回焦点，连续缩放时体验极差。
 */

import { useEffect, useRef } from 'react';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function PanZoomPlugin() {
  const { svgRef } = useViewer();
  const latest = useLatest(useViewer());
  const spaceDown = useRef(false);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

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

    let panning = false;
    let lastX = 0;
    let lastY = 0;
    let pointerId = -1;

    const onPointerDown = (event: PointerEvent) => {
      const middle = event.button === 1;
      const withSpace = event.button === 0 && spaceDown.current;
      if (!middle && !withSpace) return;

      event.preventDefault();
      panning = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!panning || event.pointerId !== pointerId) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      latest.current.setViewport((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    };

    const endPan = (event: PointerEvent) => {
      if (!panning || event.pointerId !== pointerId) return;
      panning = false;
      pointerId = -1;
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      svg.style.cursor = spaceDown.current ? 'grab' : '';
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      // 空格默认会滚动页面，必须拦掉。
      event.preventDefault();
      if (!spaceDown.current) {
        spaceDown.current = true;
        svg.style.cursor = 'grab';
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceDown.current = false;
      svg.style.cursor = '';
    };

    // 失焦时清掉空格状态：切换窗口时 keyup 收不到，否则会一直处于「抓手」态。
    const onBlur = () => {
      spaceDown.current = false;
      svg.style.cursor = '';
    };

    // wheel 必须显式 passive: false 才能 preventDefault。
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', endPan);
    svg.addEventListener('pointercancel', endPan);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', endPan);
      svg.removeEventListener('pointercancel', endPan);
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
