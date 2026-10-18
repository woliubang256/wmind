/**
 * 查看器（`MindMapViewer`）的对外契约。
 *
 * 核心设计：查看器只负责「几何 + 样式 → SVG」，**所有交互都是插件**。
 * 编辑器传入全套插件（平移缩放 / 选中 / 编辑 / 拖拽），分享页只传前两个
 * （平移缩放 / 折叠）。这样只读模式不是「把编辑功能用 CSS 藏起来」，
 * 而是那些插件根本没挂载——没有事件处理器，也没有可编辑元素。
 *
 * 这不是过度设计。反过来做（先写死编辑器、再补只读模式）意味着渲染层里
 * 到处是 `if (readOnly) return`，而漏一处就是一个「分享页能改别人导图」的
 * 安全问题。docs/08 §4.1 把这条列为 M2 最不该付出的返工成本。
 */

import type { ComponentType, RefObject } from 'react';
import type { Sheet, Theme } from '../model/types';
import type { LayoutResult, Point } from '../layout/types';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * 一个交互插件。
 *
 * `Overlay` 在 `<svg>` 内、viewport 变换之后渲染，因此可以用画布坐标系画东西
 * （选框、拖拽指示线）。纯事件型插件返回 `null` 即可——它靠 `useEffect`
 * 往 `svgRef` 上挂原生监听，比 React 合成事件更可靠（SVG 元素的合成事件
 * 在缩放容器里会带各种 offset 问题）。
 *
 * 插件必须是组件而不是普通对象里的 hook：`plugins.map(p => p.useXxx())`
 * 会违反 hooks 规则（数组长度变化时 hook 数量变化），而组件天然有自己的
 * hook 作用域。
 */
export interface ViewerPlugin {
  key: string;
  Overlay?: ComponentType;
}

export interface ViewerContextValue {
  layout: LayoutResult;
  sheet: Sheet;
  theme: Theme;
  svgRef: RefObject<SVGSVGElement | null>;
  viewport: Viewport;
  setViewport(next: Viewport | ((prev: Viewport) => Viewport)): void;
  /** 屏幕坐标（clientX/clientY）→ 画布坐标。 */
  toWorld(clientX: number, clientY: number): Point;
  /** 当前视口对应的画布可见区域（画布坐标）。 */
  visibleBounds(): { x: number; y: number; width: number; height: number };
  readOnly: boolean;
  selection: ReadonlySet<string>;
  setSelection(ids: string[]): void;
  toggleSelection(id: string): void;
  toggleCollapse(id: string): void;
  editingId: string | null;
  beginEdit(id: string): void;
  cancelEdit(): void;
  commitTitle(id: string, title: string): void;
}
