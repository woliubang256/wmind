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
