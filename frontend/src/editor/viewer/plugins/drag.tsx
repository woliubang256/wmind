/**
 * 拖拽插件（仅编辑器）。
 *
 * 三个状态：待定（按下但没动）→ 拖拽中（越过 4px 阈值）→ 落定。
 *
 * 4px 阈值不是玄学：没有它，用户想「点一下选中」时手指的 1~2px 抖动会被
 * 当成拖拽，节点被挪到相邻位置，而他以为自己只是点了一下。阈值按**屏幕**
 * 像素算而不是画布坐标——缩放到 20% 时画布里的 4px 只有屏幕上的 0.8px，
 * 按画布算等于没有阈值。
 *
 * 落点判定全部在 `drop-target.ts` 里（纯函数）。这里只负责：把指针位置
 * 喂进去、把结果画出来、松手时派发命令。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Point, Rect } from '../../layout/types';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';
import { resolveDrop, type DropCandidate, type DropRejection } from '../../interaction/drop-target';

const DRAG_THRESHOLD = 4;
const ACCENT = 'var(--wmind-selection, #1E88E5)';
const DANGER = '#E53935';

interface DragSession {
  /** 被拖的节点（拖动开始时确定，中途不变）。 */
  ids: string[];
  /** 指针按下的位置：屏幕坐标用于阈值，画布坐标用于画幽灵。 */
  startClient: Point;
  startWorld: Point;
  /** 是否已经越过阈值。 */
  active: boolean;
  /** 按下时点中的那个节点，用于「单击收敛选区」。 */
  anchorId: string;
  /** 按下时带了 Shift / Ctrl / ⌘：这是加选，松手时不能把选区收敛成一个。 */
  additive: boolean;
}

interface DragView {
  ids: string[];
  pointer: Point;
  offset: Point;
  candidate: DropCandidate | null;
}

const REASON_TEXT: Record<DropRejection, string> = {
  self: '不能放到自己身上',
  descendant: '不能放到自己的子节点里',
  root: '中心主题不能移动',
  'floating-target': '自由主题不能作为父节点',
};

export function DragPlugin() {
  const { svgRef, layout } = useViewer();
  const latest = useLatest(useViewer());

  const session = useRef<DragSession | null>(null);
  const frame = useRef(0);
  const latestPoint = useRef<Point | null>(null);
  const [view, setView] = useState<DragView | null>(null);

  // 被拖节点的包围盒（画布坐标），用来画半透明幽灵。
  const union = useMemo<Rect | null>(() => {
    if (!view) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const id of view.ids) {
      const box = layout.boxes.get(id);
      if (!box) continue;
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }
    if (left === Infinity) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, [view, layout]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    const flush = () => {
      frame.current = 0;
      const pointer = latestPoint.current;
      const current = session.current;
      if (!pointer || !current) return;
      const { layout: currentLayout, sheet } = latest.current;
      setView({
        ids: current.ids,
        pointer,
        offset: { x: pointer.x - current.startWorld.x, y: pointer.y - current.startWorld.y },
        candidate: resolveDrop(currentLayout.boxes, sheet, current.ids, pointer),
      });
    };

    const schedule = (pointer: Point) => {
      latestPoint.current = pointer;
      // 每帧最多算一次：pointermove 在高刷屏上能到 240Hz，
      // 每次都做一次全量落点扫描纯属浪费，而人眼分辨不出 4ms 的差别。
      if (frame.current) return;
      frame.current = requestAnimationFrame(flush);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest('[data-collapse-toggle]')) return;
      const node = target.closest('[data-topic-id]');
      if (!node) return;
      const id = node.getAttribute('data-topic-id');
      if (!id) return;

      const { selection, toWorld } = latest.current;

      // 拖动已选中的节点时带上整个选区：多选拖拽是基本操作，
      // 否则用户得一个一个拖。
      const ids = selection.has(id) ? [...selection] : [id];
      session.current = {
        ids,
        anchorId: id,
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
        startClient: { x: event.clientX, y: event.clientY },
        startWorld: toWorld(event.clientX, event.clientY),
        active: false,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const current = session.current;
      if (!current) return;

      if (!current.active) {
        const dx = event.clientX - current.startClient.x;
        const dy = event.clientY - current.startClient.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        current.active = true;
        // 捕获指针：拖出 svg 边界（甚至拖到工具栏上）也要继续收到事件，
        // 否则松手时收不到 pointerup，拖拽状态会卡住。
        svg.setPointerCapture(event.pointerId);
      }

      schedule(latest.current.toWorld(event.clientX, event.clientY));
    };

    const onPointerUp = (event: PointerEvent) => {
      const current = session.current;
      session.current = null;
      latestPoint.current = null;
      if (frame.current) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
      }
      setView(null);
      if (!current) return;

      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);

      const { layout: currentLayout, sheet, toWorld, setSelection, moveTopics, detachTopics } =
        latest.current;

      // 没越过阈值 = 一次普通点击。多选状态下点其中一个节点，收敛到它。
      // 带修饰键的点击是「加选 / 减选」，收敛会把刚加上的那个又踢掉。
      if (!current.active) {
        if (!current.additive && current.ids.length > 1) setSelection([current.anchorId]);
        return;
      }

      const candidate = resolveDrop(
        currentLayout.boxes,
        sheet,
        current.ids,
        toWorld(event.clientX, event.clientY),
      );
      if (!candidate || !candidate.valid || candidate.noop) return;

      if (candidate.mode === 'detach') detachTopics(current.ids);
      else if (candidate.parentId) {
        moveTopics(current.ids, candidate.parentId, candidate.index ?? undefined);
      }
    };

    // Esc 中断拖拽：拖到一半发现拖错了，用户的第一反应是取消。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !session.current) return;
      session.current = null;
      setView(null);
    };

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', onPointerUp);
      svg.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [svgRef, latest]);

  if (!view) return null;

  const { candidate } = view;
  const color = candidate && candidate.valid ? ACCENT : DANGER;
  const target = candidate?.targetId ? layout.boxes.get(candidate.targetId) : undefined;

  return (
    <g className="wmind-drag-layer" pointerEvents="none">
      {/* 幽灵：跟着指针走的半透明轮廓，让人知道「我正拿着它」。 */}
      {union ? (
        <rect
          x={union.x + view.offset.x}
          y={union.y + view.offset.y}
          width={union.width}
          height={union.height}
          rx={8}
          fill={ACCENT}
          fillOpacity={0.08}
          stroke={ACCENT}
          strokeOpacity={0.5}
          strokeDasharray="5 4"
          strokeWidth={1.5}
        />
      ) : null}

      {/* 落点提示：成为子节点画外框，同级插入画一条线。 */}
      {candidate && candidate.valid && target ? (
        candidate.mode === 'child' ? (
          <rect
            x={target.x - 5}
            y={target.y - 5}
            width={target.width + 10}
            height={target.height + 10}
            rx={Math.min(12, target.height / 2) + 5}
            fill={ACCENT}
            fillOpacity={0.1}
            stroke={ACCENT}
            strokeWidth={2}
          />
        ) : candidate.mode === 'detach' ? null : (
          <line
            x1={target.x}
            x2={target.x + target.width}
            y1={candidate.mode === 'before' ? target.y - 3 : target.y + target.height + 3}
            y2={candidate.mode === 'before' ? target.y - 3 : target.y + target.height + 3}
            stroke={ACCENT}
            strokeWidth={3}
            strokeLinecap="round"
          />
        )
      ) : null}

      {/* 非法落点：整块目标描红 + 指针旁写明原因。
          只变颜色不够——红绿色盲用户看不出区别，而「为什么不行」本身
          也是用户需要的信息。 */}
      {candidate && !candidate.valid && target ? (
        <>
          <rect
            x={target.x - 5}
            y={target.y - 5}
            width={target.width + 10}
            height={target.height + 10}
            rx={Math.min(12, target.height / 2) + 5}
            fill={DANGER}
            fillOpacity={0.08}
            stroke={DANGER}
            strokeWidth={2}
            strokeDasharray="6 4"
          />
          <text
            x={target.x}
            y={target.y - 12}
            style={{ fontSize: 12, fontWeight: 600, fill: DANGER }}
            stroke="#FFFFFF"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {candidate.reason ? REASON_TEXT[candidate.reason] : '不可放置'}
          </text>
        </>
      ) : null}

      {/* 拖到空白：明确告诉用户「会变成自由主题」，而不是静默发生。 */}
      {candidate?.mode === 'detach' ? (
        <text
          x={view.pointer.x + 14}
          y={view.pointer.y - 10}
          style={{ fontSize: 12, fontWeight: 600, fill: ACCENT }}
          stroke="#FFFFFF"
          strokeWidth={3}
          paintOrder="stroke"
        >
          松开转为自由主题
        </text>
      ) : null}

      {view.ids.length > 1 ? (
        <text
          x={view.pointer.x + 14}
          y={view.pointer.y + 16}
          style={{ fontSize: 12, fontWeight: 600, fill: color }}
          stroke="#FFFFFF"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {view.ids.length} 个主题
        </text>
      ) : null}
    </g>
  );
}
