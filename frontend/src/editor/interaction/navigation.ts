/**
 * 键盘导航的落点计算。
 *
 * 分两套语义，与 docs/05 §4.6.2 一致：
 *
 * - **方向键（无修饰）**：几何邻接。往哪个方向按，就选那个方向上「最近」
 *   的节点。不关心父子关系，所以跨分支跳转是自然的。
 * - **方向键 + Ctrl/⌘**：结构跳转。父 / 子 / 上一个兄弟 / 下一个兄弟。
 *
 * 为什么不统一成结构跳转：导图里「右边那个节点」往往比「第一个子节点」
 * 更符合直觉——尤其当分支很长、或者刚用鼠标点过一个远处节点之后。
 * 反过来，结构跳转对「沿一条分支上下走」更精确，所以两者都要有。
 *
 * 这里全部是纯函数，输入是布局结果与画布，不碰 DOM，因此可以在 node
 * 环境里直接测。
 */

import type { NodeBox } from '../layout/types';
import type { Sheet } from '../model/types';
import { findTopicInSheet, siblingList } from '../model/traverse';

export type NavDirection = 'up' | 'down' | 'left' | 'right';
export type StructuralDirection = 'parent' | 'child' | 'prev-sibling' | 'next-sibling';

/** 中心点。盒子有宽高，用中心比较才不会被长标题拉偏。 */
function centerOf(box: NodeBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * 几何邻接。
 *
 * 打分规则：`score = 主轴距离 + 0.5 × 侧向偏移`，且**优先**在「锥形」内
 * （侧向偏移 ≤ 主轴距离，即偏离方向不超过 45°）挑选。锥内挑不到时才退化到
 * 锥外，此时把侧向偏移的权重提到 2，让「大致朝那个方向」仍然成立。
 *
 * 为什么要锥：从根节点按 `→` 时，右侧所有一级分支都是候选。纯按
 * `主轴 + 0.5 × 侧向` 打分，远处同高的节点（侧向 0）会赢过近处偏上的子节点
 * （侧向 200），于是按一下右键直接飞到另一个分支的末端。锥形过滤把
 * 「明显不在那个方向」的候选先排除掉，剩下的按距离取最近。
 *
 * 主轴距离必须为正：往右就是 x 更大，往上是 y 更小。相等（同一列）不算，
 * 否则在一列上左右键会原地打转。
 */
export function geometricNeighbor(
  boxes: ReadonlyMap<string, NodeBox>,
  fromId: string,
  direction: NavDirection,
): string | null {
  const from = boxes.get(fromId);
  if (!from) return null;
  const origin = centerOf(from);

  let inCone: { id: string; score: number } | null = null;
  let outside: { id: string; score: number } | null = null;

  for (const box of boxes.values()) {
    if (box.id === fromId) continue;
    const target = centerOf(box);
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;

    let primary: number;
    let cross: number;
    switch (direction) {
      case 'right':
        primary = dx;
        cross = dy;
        break;
      case 'left':
        primary = -dx;
        cross = dy;
        break;
      case 'down':
        primary = dy;
        cross = dx;
        break;
      case 'up':
        primary = -dy;
        cross = dx;
        break;
    }

    // 半个像素的容差：浮点布局算出来的同一列可能差 0.0001。
    if (primary <= 0.5) continue;
    const lateral = Math.abs(cross);

    if (lateral <= primary) {
      const score = primary + lateral * 0.5;
      if (!inCone || score < inCone.score) inCone = { id: box.id, score };
    } else {
      const score = primary + lateral * 2;
      if (!outside || score < outside.score) outside = { id: box.id, score };
    }
  }

  return (inCone ?? outside)?.id ?? null;
}

/**
 * 结构跳转。
 *
 * `child` 在折叠状态下返回 `null` 而不是「第一个子节点」：折叠后子节点
 * 不在布局里，选中它等于选中一个看不见的东西，用户会以为选区丢了。
 */
export function structuralNeighbor(
  sheet: Sheet,
  fromId: string,
  direction: StructuralDirection,
): string | null {
  const found = findTopicInSheet(sheet, fromId);
  if (!found) return null;

  switch (direction) {
    case 'parent':
      return found.parent?.id ?? null;

    case 'child': {
      if (found.topic.collapsed) return null;
      const children = found.topic.children.attached;
      return children.length > 0 ? children[0]!.id : null;
    }

    case 'prev-sibling':
    case 'next-sibling': {
      const siblings = siblingList(sheet, fromId);
      if (siblings.length <= 1) return null;
      const index = siblings.findIndex((topic) => topic.id === fromId);
      if (index < 0) return null;
      const next = direction === 'prev-sibling' ? index - 1 : index + 1;
      return siblings[next]?.id ?? null;
    }
  }
}
