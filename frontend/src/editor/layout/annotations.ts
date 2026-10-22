/**
 * 概要 / 边界 / 关系线的几何。
 *
 * 这三者都是「画在主题之间」的附属结构，不参与主题树的位置计算，却同样需要
 * 世界坐标——所以单独一层：布局层算主题，这一层在算好的主题盒子上量出附属
 * 结构的位置。渲染层只负责把坐标画出来（`viewer/decorations.tsx`），导出与
 * 缩略图走的是同一份结果。
 *
 * 为什么不把它们塞进 `layoutMindmap`：
 *
 * - 主题布局是**树**的计算（子树尺寸、兄弟对齐、折叠），附属结构是**区间**
 *   的计算（一组兄弟的并集），两者的输入不同、失败模式也不同；
 * - 概要的位置依赖「被概要的那几个兄弟最终落在哪」，只能在主题布局之后算；
 * - 分开之后，改概要的画法不需要重跑 876 行的布局，也不会碰到折叠逻辑。
 *
 * 三者共用「区间并集」这一个原语：边界是一圈虚线框，概要是右侧的括号加节点，
 * 关系线是两点之间的一段弧。谁都没有自己的坐标系。
 */

import { collectBoundaries, collectSummaries } from '../model/traverse';
import type { Boundary, Relationship, Sheet, Summary, Theme } from '../model/types';
import { measureText } from './measure';
import type { ComputedStyle } from '../model/types';
import type { LayoutResult, Point, Rect } from './types';

/** 附属结构的尺寸常量。集中在这里，测试与渲染读同一份。 */
export const ANNOTATION_METRICS = {
  /** 边界框相对覆盖范围的留白。 */
  boundaryPadding: 16,
  /** 概要节点与被概要范围的间距。 */
  summaryGap: 26,
  summaryPaddingX: 10,
  summaryPaddingY: 6,
  /** 概要标题的最大宽度，超过就折行。 */
  summaryMaxWidth: 180,
  /** 括号两端的圆角半径。 */
  braceArm: 12,
  /** 关系线的虚线节奏。 */
  relationshipDash: '5 4',
} as const;

export interface SummaryAnnotation {
  id: string;
  topicId: string;
  range: string[];
  title: string;
  lines: string[];
  rect: Rect;
  /** 括号的 SVG `d`：贴着被概要范围的右缘，开口朝左。 */
  brace: string;
  /** 从括号中点连到概要节点的横线。 */
  connector: { from: Point; to: Point };
  style: SummaryStyle;
}

export interface SummaryStyle {
  fill: string;
  borderColor: string;
  borderWidth: number;
  textColor: string;
  fontSize: number;
  fontFamily: ComputedStyle['fontFamily'];
  fontWeight: number;
}

export interface BoundaryAnnotation {
  id: string;
  range: string[];
  title: string;
  rect: Rect;
  stroke: string;
  strokeWidth: number;
  strokeDasharray: string | undefined;
  fill: string;
  fillOpacity: number;
}

export interface RelationshipAnnotation {
  id: string;
  title: string;
  from: Point;
  to: Point;
  control: Point;
  label: Point;
  color: string;
  width: number;
  dash: string | undefined;
}

export interface AnnotationLayout {
  summaries: SummaryAnnotation[];
  boundaries: BoundaryAnnotation[];
  relationships: RelationshipAnnotation[];
  /**
   * 三者合起来的包围盒（世界坐标）。
   *
   * 「缩放到适应」与导出裁剪都要把它并进主题的包围盒里：概要节点挂在最右
   * 一侧，不算进来的话，点一次「适应」它就有一半在屏幕外。
   */
  bounds: Rect | null;
}

/** 一组矩形的并集，外扩 `pad`。没有矩形时返回 null。 */
export function unionRect(rects: readonly Rect[], pad = 0): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    if (rect.x < minX) minX = rect.x;
    if (rect.y < minY) minY = rect.y;
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/**
 * 括号路径（开口朝左的 `]`）。
 *
 * 上端从被概要范围的右缘横着出来，拐弯后沿竖线走到下端，再拐回右缘。
 * `arm` 取 `min(braceArm, 高度/2)`：范围只有一个节点时高度很小，硬画 12px
 * 的圆角会让两端叠在一起，看起来像一团。
 */
export function bracePath(rect: Rect, arm = ANNOTATION_METRICS.braceArm): string {
  const x = rect.x + rect.width;
  const bx = x + ANNOTATION_METRICS.summaryGap / 2;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const radius = Math.min(arm, rect.height / 2);
  return [
    `M ${x} ${top}`,
    `Q ${bx} ${top} ${bx} ${top + radius}`,
    `L ${bx} ${bottom - radius}`,
    `Q ${bx} ${bottom} ${x} ${bottom}`,
  ].join(' ');
}

/** 概要节点的样式：主题的 `summaryTopic` 盖在全局字体之上。 */
export function summaryStyle(theme: Theme): SummaryStyle {
  const style = theme.summaryTopic ?? {};
  return {
    fill: style.fill ?? theme.palette.backgroundColor,
    borderColor: style.borderColor ?? theme.palette.lineColors[0] ?? '#999999',
    borderWidth: style.borderWidth ?? 1.5,
    textColor: style.textColor ?? '#333333',
    // 概要比正文小一号：它是注释，不是主题。
    fontSize: style.fontSize ?? Math.max(12, theme.global.fontSize - 2),
    fontFamily: style.fontFamily ?? theme.global.fontFamily,
    fontWeight: style.fontWeight ?? 500,
  };
}

function dashFor(style: 'solid' | 'dash' | 'dot' | 'none', width: number): string | undefined {
  if (style === 'dash') return `${width * 3} ${width * 2}`;
  if (style === 'dot') return `${width} ${width * 2}`;
  if (style === 'none') return undefined;
  return undefined;
}

/**
 * 概要的矩形：贴在范围的右侧、竖直居中。
 *
 * 标题按 `summaryMaxWidth` 折行——XMind 的概要节点不会横向长到把画布撑开，
 * 长文本一律折行。
 */
function layoutSummary(
  summary: Summary,
  range: Rect,
  style: SummaryStyle,
): { rect: Rect; lines: string[] } {
  const font = { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, italic: false };
  const measured = measureText(summary.title, font, ANNOTATION_METRICS.summaryMaxWidth);
  const width = Math.max(
    48,
    Math.min(ANNOTATION_METRICS.summaryMaxWidth, measured.width) + ANNOTATION_METRICS.summaryPaddingX * 2,
  );
  const height = measured.height + ANNOTATION_METRICS.summaryPaddingY * 2;
  return {
    rect: {
      x: range.x + range.width + ANNOTATION_METRICS.summaryGap,
      y: range.y + range.height / 2 - height / 2,
      width,
      height,
    },
    lines: measured.lines,
  };
}

/**
 * 关系线：两端节点的中心之间画一段外推的弧。
 *
 * 控制点从弦的中点沿法线外推，而不是直接用中点——直接用中点时二次贝塞尔
 * 退化成直线，两个节点横向相邻时直线正好穿过它们中间的那个节点，标题也
 * 跟着被压在节点下面看不见。外推幅度取弦长的四分之一并封顶 60px。
 */
export function relationshipArc(from: Rect, to: Rect): { from: Point; to: Point; control: Point; label: Point } {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height / 2;
  const x2 = to.x + to.width / 2;
  const y2 = to.y + to.height / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const bulge = Math.min(60, length * 0.25);
  const control = {
    x: (x1 + x2) / 2 - (dy / length) * bulge,
    y: (y1 + y2) / 2 + (dx / length) * bulge,
  };
  return {
    from: { x: x1, y: y1 },
    to: { x: x2, y: y2 },
    control,
    // 二次贝塞尔在 t = 0.5 处的点。
    label: { x: (x1 + 2 * control.x + x2) / 4, y: (y1 + 2 * control.y + y2) / 4 },
  };
}

/** 范围里能对上盒子的那些（折叠的、被删掉的 id 直接忽略）。 */
function rectsOf(layout: LayoutResult, range: readonly string[]): Rect[] {
  const rects: Rect[] = [];
  for (const id of range) {
    const box = layout.boxes.get(id);
    if (box !== undefined) rects.push(box);
  }
  return rects;
}

export function layoutAnnotations(sheet: Sheet, layout: LayoutResult, theme: Theme): AnnotationLayout {
  const summary: SummaryStyle = summaryStyle(theme);

  const summaries: SummaryAnnotation[] = [];
  for (const item of collectSummaries(sheet)) {
    const rects = rectsOf(layout, item.range);
    const range = unionRect(rects);
    if (range === null) continue;
    const placed = layoutSummary(item, range, summary);
    summaries.push({
      id: item.id,
      topicId: item.topicId,
      range: item.range,
      title: item.title,
      lines: placed.lines,
      rect: placed.rect,
      brace: bracePath(range),
      connector: {
        from: { x: range.x + range.width + ANNOTATION_METRICS.summaryGap / 2, y: range.y + range.height / 2 },
        to: { x: placed.rect.x, y: placed.rect.y + placed.rect.height / 2 },
      },
      style: summary,
    });
  }

  const boundaries: BoundaryAnnotation[] = [];
  for (const boundary of collectBoundaries(sheet)) {
    const rect = unionRect(rectsOf(layout, boundary.range), ANNOTATION_METRICS.boundaryPadding);
    if (rect === null) continue;
    const style = boundary.style ?? {};
    const stroke = style.borderColor ?? theme.boundary?.borderColor ?? theme.palette.lineColors[0] ?? '#999999';
    const width = style.borderWidth ?? theme.boundary?.borderWidth ?? 1.5;
    boundaries.push({
      id: boundary.id,
      range: boundary.range,
      title: boundary.title,
      rect,
      stroke,
      strokeWidth: width,
      strokeDasharray: dashFor(style.borderStyle ?? theme.boundary?.borderStyle ?? 'dash', width),
      fill: style.fill ?? theme.boundary?.fill ?? 'none',
      fillOpacity: 0.5,
    });
  }

  const relationships: RelationshipAnnotation[] = [];
  for (const relationship of sheet.relationships) {
    const from = layout.boxes.get(relationship.end1Id);
    const to = layout.boxes.get(relationship.end2Id);
    if (from === undefined || to === undefined) continue;
    const arc = relationshipArc(from, to);
    const style = relationship.style ?? {};
    relationships.push({
      id: relationship.id,
      title: relationship.title,
      from: arc.from,
      to: arc.to,
      control: arc.control,
      label: arc.label,
      color: style.lineColor ?? theme.relationship?.lineColor ?? theme.palette.lineColors[0] ?? '#999999',
      width: style.lineWidth ?? theme.relationship?.lineWidth ?? 1.5,
      dash: ANNOTATION_METRICS.relationshipDash,
    });
  }

  // 关系线不参与包围盒：两端都在节点中心，弧顶最多外推 60px，撑不开画布。
  // 概要节点与边界框会，所以它们要算进来。
  const bounds = unionRect([
    ...boundaries.map((item) => item.rect),
    ...summaries.map((item) => item.rect),
  ]);

  return { summaries, boundaries, relationships, bounds };
}

export type { Boundary, Relationship };
