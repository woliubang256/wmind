/**
 * 框选插件（仅编辑器）。
 *
 * 在空白处按下并拖动画选框，松手时选中所有与选框**相交**的节点。
 *
 * 相交而不是包含：用户随手划一道横线，期望选中被扫到的那几个节点；
 * 要求「完全框住」会逼着他把框画得比内容大一圈，在缩小状态下很别扭。
 *
 * 与拖拽插件的分工很干净：拖拽从「按在节点上」开始，框选从「按在空白处」
 * 开始，两者靠 `pointerdown` 的目标区分，不需要互相通信。
 */

import { useEffect, useRef, useState } from 'react';
import type { Point, Rect } from '../../layout/types';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';
import { boxesInRect } from '../../interaction/drop-target';

/** 小于这个位移就当成点击（SelectionPlugin 已经把选区清空了）。 */
const MIN_SIZE = 4;
const ACCENT = 'var(--wmind-selection, #1E88E5)';

export function MarqueePlugin() {
  const { svgRef } = useViewer();
  const latest = useLatest(useViewer());
  const start = useRef<Point | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      // 按在节点或折叠按钮上，交给选中 / 拖拽插件。
      if (!target || target.closest('[data-topic-id]') || target.closest('[data-collapse-toggle]')) {
        return;
      }
      // 空格拖拽是平移，不画选框。
      if (event.shiftKey) return;
      start.current = latest.current.toWorld(event.clientX, event.clientY);
      setRect(null);
    };

    const onPointerMove = (event: PointerEvent) => {
      const origin = start.current;
      if (!origin) return;
      const point = latest.current.toWorld(event.clientX, event.clientY);
      const next = {
        x: origin.x,
        y: origin.y,
        width: point.x - origin.x,
        height: point.y - origin.y,
      };
      if (Math.abs(next.width) < MIN_SIZE && Math.abs(next.height) < MIN_SIZE) return;
      setRect(next);
    };

    const finish = (event: PointerEvent) => {
      const origin = start.current;
      start.current = null;
      setRect(null);
      if (!origin) return;
      const { layout, toWorld, setSelection } = latest.current;
      const point = toWorld(event.clientX, event.clientY);
      const width = point.x - origin.x;
      const height = point.y - origin.y;
      // 位移太小 = 一次空白处点击，SelectionPlugin 已经清空选区，这里不动。
      if (Math.abs(width) < MIN_SIZE && Math.abs(height) < MIN_SIZE) return;
      setSelection(boxesInRect(layout.boxes, { x: origin.x, y: origin.y, width, height }));
    };

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);
    return () => {
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', finish);
      svg.removeEventListener('pointercancel', finish);
    };
  }, [svgRef, latest]);

  if (!rect) return null;

  return (
    <rect
      className="wmind-marquee"
      x={Math.min(rect.x, rect.x + rect.width)}
      y={Math.min(rect.y, rect.y + rect.height)}
      width={Math.abs(rect.width)}
      height={Math.abs(rect.height)}
      fill={ACCENT}
      fillOpacity={0.08}
      stroke={ACCENT}
      strokeWidth={1}
      strokeDasharray="4 3"
      pointerEvents="none"
    />
  );
}
