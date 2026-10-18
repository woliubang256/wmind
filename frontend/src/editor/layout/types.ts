/**
 * 布局与渲染共用的几何类型。
 *
 * `LayoutResult` 是内核层与渲染层之间唯一的契约：布局只管算坐标，
 * 渲染只管把坐标画出来。两者之间不传 React 元素、不传 DOM 引用，
 * 因此同一份结果既能喂给编辑器，也能喂给只读查看器、缩略图导出
 * 和将来的服务端渲染。
 */

import type { LineEnd, LineStyle } from '../model/types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = 'left' | 'right' | 'none';

export interface NodeBox extends Rect {
  id: string;
  depth: number;
  /** 一级分支序号，决定取色；根与自由主题为 -1。 */
  branchIndex: number;
  side: Side;
  collapsed: boolean;
  /** 折叠时被隐藏的后代总数（含多层），展开时为 0。 */
  hiddenChildren: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 一条父子连线。端点已经算在节点边缘上，渲染层不再做几何计算。 */
export interface EdgePath {
  /** 稳定 key：`<parentId>-><childId>`。 */
  id: string;
  parentId: string;
  childId: string;
  from: Point;
  to: Point;
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
}

export interface TopicSize {
  width: number;
  height: number;
  /** 折行后的文本行。渲染层直接逐行输出 `<tspan>`。 */
  lines: string[];
}
