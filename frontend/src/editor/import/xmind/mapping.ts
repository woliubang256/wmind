/**
 * XMind 的类名 / 标记 id → wmind 枚举的对照表。
 *
 * 全部是**封闭映射**：表里没有的一律回退或丢弃，绝不把原值直接写进文档。
 * 原值来自用户机器上的 XMind 版本，写进 `.wmind` 就等于把「只有那台机器
 * 认识的字符串」固化进存档。
 *
 * 对照依据：docs/03 §2.4.1（形状）、§5.5（标记）。
 */

import type { ShapeClass, StructureClass } from '../../model/types';

/** XMind `structureClass` → 本项目结构。见 docs/03 §2.1。 */
const STRUCTURES: Record<string, StructureClass> = {
  'org.xmind.ui.map.unbalanced': 'mindmap',
  'org.xmind.ui.map.clockwise': 'mindmap',
  'org.xmind.ui.map.anticlockwise': 'mindmap',
  'org.xmind.ui.logic.right': 'logic-right',
  'org.xmind.ui.logic.left': 'logic-left',
  'org.xmind.ui.org-chart.down': 'org-chart',
  'org.xmind.ui.org-chart.up': 'org-chart',
  'org.xmind.ui.tree.right': 'tree-right',
  'org.xmind.ui.tree.left': 'tree-right',
  'org.xmind.ui.timeline': 'timeline',
  'org.xmind.ui.fishbone.leftHeaded': 'fishbone',
  'org.xmind.ui.fishbone.rightHeaded': 'fishbone',
  'org.xmind.ui.brace.right': 'brace',
  'org.xmind.ui.brace.left': 'brace',
  'org.xmind.ui.spreadsheet': 'tree-table',
};

export interface StructureMapping {
  structure: StructureClass;
  /** false 表示原值不认识，调用方要记一条 `structure-fallback` 警告。 */
  known: boolean;
}

export function mapStructure(raw: string | undefined): StructureMapping | null {
  if (raw === undefined || raw === '') return null;
  const hit = STRUCTURES[raw];
  if (hit !== undefined) return { structure: hit, known: true };
  return { structure: 'mindmap', known: false };
}

/** XMind `shape-class` → 本项目形状。见 docs/03 §2.4.1。 */
const SHAPES: Record<string, ShapeClass> = {
  'org.xmind.ui.rect': 'rect',
  'org.xmind.ui.roundedRect': 'rounded-rect',
  'org.xmind.ui.capsule': 'capsule',
  'org.xmind.ui.ellipse': 'ellipse',
  'org.xmind.ui.circle': 'circle',
  'org.xmind.ui.diamond': 'diamond',
  'org.xmind.ui.hexagon': 'hexagon',
  'org.xmind.ui.parallelogram': 'parallelogram',
  'org.xmind.ui.underline': 'underline',
  'org.xmind.ui.none': 'none',
};

/** 不认识的形状返回 undefined，让该字段保持「继承主题」而不是硬塞一个默认值。 */
export function mapShape(raw: string | undefined): ShapeClass | undefined {
  if (raw === undefined) return undefined;
  return SHAPES[raw];
}

/**
 * 标记分组。docs/03 §5.5 的一期清单，顺序即界面里的分组顺序。
 *
 * 做成「分组 → 成员」而不是扁平集合，是因为 `Marker` 需要 `groupId`，
 * 而 XMind 的 `markerId` 本身是扁平的（`priority-1` / `task-done`）。
 */
export const MARKER_GROUPS: Record<string, readonly string[]> = {
  priority: [
    'priority-1', 'priority-2', 'priority-3', 'priority-4', 'priority-5',
    'priority-6', 'priority-7', 'priority-8', 'priority-9',
  ],
  task: [
    'task-start', 'task-quarter', 'task-half', 'task-three-quarter',
    'task-done', 'task-pause', 'task-cancel',
  ],
  flag: ['flag-red', 'flag-orange', 'flag-yellow', 'flag-green', 'flag-blue', 'flag-purple', 'flag-gray'],
  star: ['star-red', 'star-orange', 'star-yellow', 'star-green', 'star-blue', 'star-purple'],
  symbol: [
    'symbol-plus', 'symbol-minus', 'symbol-question', 'symbol-exclamation',
    'symbol-info', 'symbol-smile', 'symbol-cry', 'symbol-warning',
  ],
  people: ['people-1', 'people-2', 'people-3', 'people-4', 'people-5'],
};

const MARKER_GROUP_OF = new Map<string, string>();
for (const [group, ids] of Object.entries(MARKER_GROUPS)) {
  for (const id of ids) MARKER_GROUP_OF.set(id, group);
}

export interface MarkerMapping {
  groupId: string;
  markerId: string;
}

/** 认识的标记返回分组信息，不认识的返回 null（调用方计入 `marker-unknown`）。 */
export function mapMarker(markerId: string): MarkerMapping | null {
  const groupId = MARKER_GROUP_OF.get(markerId);
  if (groupId === undefined) return null;
  return { groupId, markerId };
}
