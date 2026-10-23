/**
 * 拖拽落点判定。
 *
 * 全是纯函数：输入布局、画布、被拖节点、指针位置，输出「这次松手会发生什么」。
 * 拖拽是交互层里最难在浏览器里断言的部分——「拖到这里算成为子节点还是插到
 * 后面」靠肉眼判断，而肉眼判断的标准每次都会飘。把它抽成纯函数之后，
 * 落点语义、合法性、下标修正都能直接测。
 *
 * 语义（docs/05 §4.6.3）：
 *
 * ```
 *   指针落在目标节点的上 25%  → 插到它前面（同级）
 *   指针落在中间 50%          → 成为它的子节点
 *   指针落在下 25%            → 插到它后面（同级）
 *   回到原主题外框及附近 24px → 保持原位置（无需提交）
 *   指针离所有节点都很远      → 脱离树，变成自由主题
 * ```
 */

import type { NodeBox, Point } from '../layout/types';
import type { Sheet } from '../model/types';
import { findTopicInSheet, isDescendant } from '../model/traverse';

/** 指针离盒子多远仍算「瞄准了它」。太小的值会让空白处几乎无法脱离。 */
const DROP_MARGIN = 28;
/** 原主题附近的回归范围按屏幕像素算，缩放后仍容易拖回。 */
const RETURN_MARGIN = 24;
/** 上下边缘判定为「同级插入」的比例。 */
const EDGE_RATIO = 0.25;

export type DropMode = 'child' | 'before' | 'after' | 'detach' | 'restore';

export type DropRejection = 'self' | 'descendant' | 'root' | 'floating-target';

export interface DropCandidate {
  mode: DropMode;
  /** 目标节点；`detach` 时为 null。 */
  targetId: string | null;
  /** 落定后的父节点；`detach` / `restore` 时为 null。 */
  parentId: string | null;
  /** 插入下标；`detach` / `restore` / `child`（追加到末尾）时为 null。 */
  index: number | null;
  valid: boolean;
  reason: DropRejection | null;
  /** 落点就是当前位置：合法但没有必要派发命令。 */
  noop: boolean;
}

/** 点到矩形的距离；点在内部为 0。 */
function distanceToBox(box: NodeBox, point: Point): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

/** 离指针最近的盒子（排除被拖的那些，否则指针永远压在自己的幽灵上）。 */
export function nearestBox(
  boxes: ReadonlyMap<string, NodeBox>,
  point: Point,
  exclude: ReadonlySet<string>,
): { box: NodeBox; distance: number } | null {
  let best: { box: NodeBox; distance: number } | null = null;
  for (const box of boxes.values()) {
    if (exclude.has(box.id)) continue;
    const distance = distanceToBox(box, point);
    if (!best || distance < best.distance) best = { box, distance };
  }
  return best;
}

/**
 * 算落点。
 *
 * 返回 null 表示「什么都不该发生」（比如被拖的全是根节点或自由主题，
 * 既不能移动也不能脱离）。
 */
export function resolveDrop(
  boxes: ReadonlyMap<string, NodeBox>,
  sheet: Sheet,
  dragIds: readonly string[],
  point: Point,
  { anchorId = dragIds[0], zoom = 1 }: { anchorId?: string; zoom?: number } = {},
): DropCandidate | null {
  const excluded = new Set(dragIds);
  const dragSet = dragIds.map((id) => findTopicInSheet(sheet, id)).filter((f) => f !== null);

  const nearest = nearestBox(boxes, point, excluded);

  // 被拖主题不能作为新父级，但它的原位置必须能取消拖拽。真实命中其他
  // 主题时让目标优先，避免紧密布局中回归范围遮住相邻主题。
  const source = anchorId && excluded.has(anchorId) ? boxes.get(anchorId) : undefined;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (source && distanceToBox(source, point) <= RETURN_MARGIN / scale && (!nearest || nearest.distance > 0)) {
    return {
      mode: 'restore',
      targetId: source.id,
      parentId: null,
      index: null,
      valid: true,
      reason: null,
      noop: true,
    };
  }

  // 空白处：脱离树。自由主题与根已经在树外，没有可脱离的东西。
  if (!nearest || nearest.distance > DROP_MARGIN) {
    const detachable = dragSet.filter((found) => found.parent !== null);
    if (detachable.length === 0) return null;
    return {
      mode: 'detach',
      targetId: null,
      parentId: null,
      index: null,
      valid: true,
      reason: null,
      noop: false,
    };
  }

  const box = nearest.box;
  const target = findTopicInSheet(sheet, box.id);
  if (!target) return null;

  const ratio = box.height > 0 ? (point.y - box.y) / box.height : 0.5;
  let mode: DropMode = ratio < EDGE_RATIO ? 'before' : ratio > 1 - EDGE_RATIO ? 'after' : 'child';

  // 根节点没有兄弟：落在它上沿/下沿时退化成「成为它的子节点」，
  // 否则用户把节点拖到根的上方会得到一个「什么都没发生」的落点。
  if (!target.parent && mode !== 'child') mode = 'child';

  const reject = (reason: DropRejection): DropCandidate => ({
    mode,
    targetId: box.id,
    parentId: null,
    index: null,
    valid: false,
    reason,
    noop: false,
  });

  if (dragIds.includes(box.id)) return reject('self');
  // 根与自由主题不能移动（自由主题没有父节点，语义上已经是「脱离」状态）。
  if (dragSet.some((found) => found.parent === null)) return reject('root');
  // 自由主题没有子树语义，不能当父节点。
  if (target.isFloating) return reject('floating-target');
  // 拖到自己的后代里 = 把这棵子树从文档里摘掉，内容全丢。
  if (dragSet.some((found) => isDescendant(found.topic, box.id))) return reject('descendant');

  if (mode === 'child') {
    return {
      mode,
      targetId: box.id,
      parentId: box.id,
      index: null,
      valid: true,
      reason: null,
      noop: false,
    };
  }

  const parent = target.parent;
  if (!parent) return reject('root');

  // 下标要按「被拖节点已经被摘掉之后」的数组算，否则同父移动会差一位：
  // 把 index 4 的节点插到 index 4，摘掉之后它其实落在 3 上，位置反了。
  let index = mode === 'before' ? target.index : target.index + 1;
  const removedBefore = dragSet.filter(
    (found) => found.parent?.id === parent.id && found.index < index,
  ).length;
  index -= removedBefore;

  // 单节点拖回原位：合法但没有可执行的变更。
  const only = dragSet.length === 1 ? dragSet[0]! : null;
  const noop = Boolean(
    only && only.parent?.id === parent.id && index === only.index,
  );

  return {
    mode,
    targetId: box.id,
    parentId: parent.id,
    index,
    valid: true,
    reason: null,
    noop,
  };
}

/** 框选：返回与矩形相交的节点 id。 */
export function boxesInRect(
  boxes: ReadonlyMap<string, { id: string; x: number; y: number; width: number; height: number }>,
  rect: { x: number; y: number; width: number; height: number },
): string[] {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);

  const ids: string[] = [];
  for (const box of boxes.values()) {
    // 相交而非包含：用户随手划一道横线，期望选中被扫到的节点。
    if (box.x + box.width < left || box.x > right) continue;
    if (box.y + box.height < top || box.y > bottom) continue;
    ids.push(box.id);
  }
  return ids;
}
