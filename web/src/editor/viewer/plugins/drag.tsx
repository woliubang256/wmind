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
import { useTranslation } from 'react-i18next';
import type { Point, Rect } from '../../layout/types';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';
import { resolveDrop, type DropCandidate, type DropRejection } from '../../interaction/drop-target';
import { PointerSession, subscribeCanvasGestureCancel } from './canvas-gestures';

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

/**
 * 拒绝原因 → i18n key。
 *
 * 文案要跟着界面语言走：拖拽时的红字提示是**唯一**告诉用户「为什么不行」的
 * 地方，只变颜色对色盲用户无效，写成中文则对英文用户无效。
 */
const REASON_KEY: Record<DropRejection, string> = {
  self: 'editor.drag.self',
  descendant: 'editor.drag.descendant',
  root: 'editor.drag.root',
  'floating-target': 'editor.drag.floatingTarget',
};

export function DragPlugin() {
  const { t } = useTranslation();
  const { svgRef, layout } = useViewer();
  const latest = useLatest(useViewer());

  const session = useRef(new PointerSession<DragSession>());
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
      bottom = Math.max(bottom, box.y + (box.outerHeight ?? box.height));
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
      const current = session.current.current();
      if (!pointer || !current) return;
      const { layout: currentLayout, sheet, viewport } = latest.current;
      setView({
        ids: current.ids,
        pointer,
        offset: { x: pointer.x - current.startWorld.x, y: pointer.y - current.startWorld.y },
        candidate: resolveDrop(currentLayout.boxes, sheet, current.ids, pointer, { anchorId: current.anchorId, zoom: viewport.zoom }),
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
      session.current.begin(event.pointerId, {
        ids,
        anchorId: id,
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
        startClient: { x: event.clientX, y: event.clientY },
        startWorld: toWorld(event.clientX, event.clientY),
        active: false,
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      const current = session.current.get(event.pointerId);
      if (!current) return;
      // 概要没有树移动语义。混合选区整批不拖动，不能悄悄只移动其中的主题。
      if (current.ids.some((id) => !latest.current.layout.boxes.has(id))) return;

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
      const current = session.current.finish(event.pointerId);
      if (!current) return;
      latestPoint.current = null;
      if (frame.current) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
      }
      setView(null);
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);

      const { layout: currentLayout, sheet, viewport, toWorld, setSelection, moveTopics, detachTopics } =
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
        { anchorId: current.anchorId, zoom: viewport.zoom },
      );
      if (!candidate || !candidate.valid || candidate.noop) return;

      if (candidate.mode === 'detach') detachTopics(current.ids);
      else if (candidate.parentId) {
        moveTopics(current.ids, candidate.parentId, candidate.index ?? undefined);
      }
    };

    const cancel = () => {
      const pointerId = session.current.id;
      session.current.cancel();
      latestPoint.current = null;
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      setView(null);
      if (pointerId !== null && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
    };
    const onCancel = (event: PointerEvent) => {
      if (session.current.get(event.pointerId)) cancel();
    };
    const onLostCapture = (event: PointerEvent) => {
      if (!svg.hasPointerCapture(event.pointerId)) onCancel(event);
    };
    const unsubscribe = subscribeCanvasGestureCancel(svg, cancel);

    // Esc and browser cancellation discard a preview, never commit a drop.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };

    svg.addEventListener('pointerdown', onPointerDown);
    // Track even a first move that jumps outside SVG before the capture threshold.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onCancel);
    svg.addEventListener('lostpointercapture', onLostCapture);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      svg.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      unsubscribe();
      cancel();
      window.removeEventListener('pointercancel', onCancel);
      svg.removeEventListener('lostpointercapture', onLostCapture);
      window.removeEventListener('blur', cancel);
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
      {union && candidate?.mode !== 'restore' ? (
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

      {/* 成为子节点或回归原位画外框，同级插入画一条线。 */}
      {candidate && candidate.valid && target ? (
        candidate.mode === 'child' || candidate.mode === 'restore' ? (
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
            {candidate.reason ? t(REASON_KEY[candidate.reason]) : t('editor.drag.invalid')}
          </text>
        </>
      ) : null}

      {/* 脱离与回归都明确显示松手结果，预览和实际提交使用同一落点。 */}
      {candidate?.mode === 'detach' || candidate?.mode === 'restore' ? (
        <text
          x={view.pointer.x + 14}
          y={view.pointer.y - 10}
          style={{ fontSize: 12, fontWeight: 600, fill: ACCENT }}
          stroke="#FFFFFF"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {t(candidate.mode === 'restore' ? 'editor.drag.restore' : 'editor.drag.toFloating')}
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
          {t('editor.drag.selectedCount', { count: view.ids.length })}
        </text>
      ) : null}
    </g>
  );
}
