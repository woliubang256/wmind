/**
 * 插件集合的两种预设。
 *
 * 这就是 M2.8 的全部意义：只读模式不是「把编辑功能藏起来」，
 * 而是**根本不挂载**那些插件。分享页拿到的是 `READ_ONLY_PLUGINS`，
 * 页面上因此不存在任何编辑事件处理器——不是靠 CSS 或 `disabled` 属性，
 * 而是那些代码没有被执行。
 */

import type { ViewerPlugin } from '../viewer-types';
import { PanZoomPlugin } from './pan-zoom';
import { CollapsePlugin } from './collapse';
import { SelectionPlugin } from './selection';
import { EditingPlugin } from './editing';
import { DragPlugin } from './drag';
import { MarqueePlugin } from './marquee';

/** 分享页：只能看、只能缩放折叠。 */
export const READ_ONLY_PLUGINS: ViewerPlugin[] = [
  { key: 'pan-zoom', Overlay: PanZoomPlugin },
  { key: 'collapse', Overlay: CollapsePlugin },
];

/**
 * 编辑器：查看 + 选中 + 双击编辑 + 拖拽 + 框选。
 *
 * 顺序即 overlay 的绘制顺序：拖拽与框选的指示图形必须压在最上面，
 * 否则会被节点盖住一半。
 */
export const EDITOR_PLUGINS: ViewerPlugin[] = [
  { key: 'pan-zoom', Overlay: PanZoomPlugin },
  { key: 'collapse', Overlay: CollapsePlugin },
  { key: 'selection', Overlay: SelectionPlugin },
  { key: 'editing', Overlay: EditingPlugin },
  { key: 'drag', Overlay: DragPlugin },
  { key: 'marquee', Overlay: MarqueePlugin },
];
