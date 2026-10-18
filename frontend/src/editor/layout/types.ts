/**
 * 布局与渲染共用的几何类型。
 *
 * `LayoutResult` 是内核层与渲染层之间唯一的契约：布局只管算坐标，
 * 渲染只管把坐标画出来。两者之间不传 React 元素、不传 DOM 引用，
 * 因此同一份结果既能喂给编辑器，也能喂给只读查看器、缩略图导出
 * 和将来的服务端渲染。
 */

import type { ComputedStyle, LineEnd, LineStyle } from '../model/types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 节点相对父节点的方位。
 *
 * `bottom` 是 `org-chart` 用的：自上而下的树里，子节点在父节点下方，
 * 折叠徽标也该落在下沿而不是右沿。`none` 只给根与自由主题。
 */
export type Side = 'left' | 'right' | 'bottom' | 'none';

export interface NodeBox extends Rect {
  id: string;
  depth: number;
  /** 一级分支序号，决定取色；根与自由主题为 -1。 */
  branchIndex: number;
  side: Side;
  collapsed: boolean;
  /** 直接子节点数（attached）。用于渲染「折叠/展开」按钮。 */
  childCount: number;
  /** 折叠时被隐藏的后代总数（含多层），展开时为 0。 */
  hiddenChildren: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * 连线的走向。
 *
 * 渲染层要靠它决定贝塞尔的控制点放在哪个中点、折线先走横还是先走竖——
 * 横向树的连线从节点侧面伸出（切线水平），纵向树的连线从下沿伸出（切线垂直）。
 * 让渲染层去猜「from.y === to.y 大概是横向吧」在斜边上会猜错。
 */
export type EdgeOrientation = 'h' | 'v';

/** 一条父子连线。端点已经算在节点边缘上，渲染层不再做几何计算。 */
export interface EdgePath {
  /** 稳定 key：`<parentId>-><childId>`。 */
  id: string;
  parentId: string;
  childId: string;
  from: Point;
  to: Point;
  orientation: EdgeOrientation;
  lineStyle: LineStyle;
  lineEnd: LineEnd;
  lineColor: string;
  lineWidth: number;
}

export interface LayoutResult {
  boxes: Map<string, NodeBox>;
  edges: EdgePath[];
  /** 所有盒子的包围盒（已含内边距），用于「缩放到适应」。 */
  bounds: Rect;
  /** 节点测量结果，渲染层要拿它取折行后的文本。 */
  sizes: Map<string, TopicSize>;
  /**
   * 每个节点的计算样式。
   *
   * 布局阶段本来就要算一遍（测量需要字号），顺手存下来，渲染层直接用。
   * 让渲染层自己再 `resolveStyle` 一次有两个坏处：多一次查表，
   * 以及万一两边的上下文（depth / branchIndex）不一致，就会出现
   * 「测出来 100px、画出来用 18px 字号」的错位。
   */
  styles: Map<string, ComputedStyle>;
}

export interface TopicSize {
  width: number;
  height: number;
  /** 折行后的文本行。渲染层直接逐行输出 `<tspan>`。 */
  lines: string[];
}
