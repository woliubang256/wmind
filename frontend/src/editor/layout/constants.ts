/**
 * 布局常量。
 *
 * 集中在一个文件里，是因为「看起来像不像 XMind」很大程度上取决于这些间距，
 * 调参时要能一眼改完。散落在各布局算法里的字面量会让微调变成考古。
 *
 * 数值取自 docs/05 §4.4。
 */

export interface LayoutSpacing {
  /** 同级节点之间的垂直间距。 */
  siblingGap: number;
  /** 父子节点之间的水平间距。 */
  levelGap: number;
  /** 画布内容四周的内边距。 */
  padding: number;
}

export const DEFAULT_SPACING: LayoutSpacing = {
  siblingGap: 24,
  levelGap: 48,
  padding: 80,
};

export const COMPACT_SPACING: LayoutSpacing = {
  siblingGap: 12,
  levelGap: 28,
  padding: 40,
};

/** 节点内部留白与文本约束。 */
export const NODE_METRICS = {
  paddingX: 12,
  paddingY: 8,
  /** 自动宽度下的最小宽度（不含内边距）。 */
  minContentWidth: 60,
  /** 自动宽度下的最大内容宽度；超过就折行。 */
  maxContentWidth: 320,
  lineHeightRatio: 1.4,
} as const;

export function spacingFor(compact: boolean): LayoutSpacing {
  return compact ? COMPACT_SPACING : DEFAULT_SPACING;
}
