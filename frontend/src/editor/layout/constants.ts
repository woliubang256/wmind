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
  /** 文本块与图片之间的竖直间距。 */
  imageGap: 6,
} as const;

/**
 * 图片的显示尺寸约束。
 *
 * XMind 把用户拖出来的尺寸写进 `image.width/height`，那个值可能大得离谱
 * （有的文件里是原图像素）。不夹一下，一个 5000px 高的节点会把整张画布的
 * 布局撑成没法看，还会让「缩放到适应」把别的节点缩成一个点。
 *
 * 只按**等比缩小**处理，不放大：小图保持原样，比放大后糊成一片强。
 */
export const IMAGE_METRICS = {
  maxWidth: 320,
  maxHeight: 240,
  /** 小于这个尺寸的图看不清，按最小尺寸撑开。 */
  minSize: 16,
} as const;


export function spacingFor(compact: boolean): LayoutSpacing {
  return compact ? COMPACT_SPACING : DEFAULT_SPACING;
}
