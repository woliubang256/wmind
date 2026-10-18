# Agent Note: SVG 渲染与只读查看器抽象：插件注入、内联样式、分层 memo

Status: implemented

## Problem

M2.3（SVG 渲染）与 M2.8（只读查看器抽象）必须同批交付——docs/08 §4 把这条写成硬约束：先写「只给编辑器用」的渲染器、之后再抽只读查看器，等于把渲染层撕开重来。

要定的事：

- 「只读」和「可编辑」的差异，落在代码结构的哪一层？
- 图形用什么画？`<path>` 拼所有形状，还是每种形状一个元素？
- 连线末端箭头用 `<marker>` 还是自己画？
- 编辑文字时输入框放哪？`foreignObject` 还是别的？
- 样式怎么落到 DOM？CSS 类还是内联属性？
- 2000 个节点，每次平移都重建全部元素会卡死，怎么切分重渲染边界？
- 主题色深浅不定，节点文字颜色怎么保证可读？

## Decision

### 只读不是「藏起来」，是「根本没挂载」

`MindMapViewer` 只做一件事：`layout + sheet + theme → SVG`。所有交互（平移缩放、折叠、选中、双击编辑）都是**插件**，通过 `plugins: ViewerPlugin[]` 注入：

```ts
export const READ_ONLY_PLUGINS = [panZoomPlugin, collapsePlugin];
export const EDITOR_PLUGINS = [panZoomPlugin, collapsePlugin, selectionPlugin, editingPlugin];
```

`readOnly` 不是插件内部的一个 `if`，而是「这一批插件没进数组」。这样：

- 只读查看器里不存在「编辑代码被禁用」的路径，也就不存在「某天有人改了 `if` 条件、只读页面突然能改名」的风险；
- 每个插件自己管自己的 DOM 监听与清理，`useEffect` 的依赖就是插件 key，不会互相牵连；
- M3 的分享页、M4 的缩略图渲染直接传 `READ_ONLY_PLUGINS`，不需要再理解编辑器。

`readOnly` 仍然会透传到 context 里，但只用于**视觉**（不渲染折叠按钮的 hover 态等），不用于行为开关。

### 内联样式属性，不用 CSS 类

所有颜色、线宽、字体都写成 SVG 属性（`fill` / `stroke` / `stroke-width` / `font-family`…），不生成 `<style>` 也不加 class。

理由是这个渲染器**同时是导出器**：M3 的 PNG/SVG 导出会把 `<svg>` 序列化后交给 canvas 或直接下载。外链样式表在序列化后全部丢失，导出图会变成一堆黑块。内联属性是唯一「拷出去还长得一样」的写法。

代价是 DOM 属性变多（每个节点约 12 个属性），但 SVG 属性本来就比 class 便宜——不需要层叠计算。

### 箭头自己画，不用 `<marker>`

`<marker>` 的问题是继承 `stroke` 只能靠 `context-stroke`，Safari 长期不支持，导致箭头永远黑色。所以 `LineEnd` 直接算三角形/圆形的三个点，`fill` 取连线颜色。

四种线型（`curve` / `straight` / `elbow` / `none`）共用同一个 `edgePath()`，`elbow` 用 `M … H … V …` 手工拐角，`curve` 用三次贝塞尔、控制点取水平方向的 1/2 距离——控制点太近会显得线「软」，太远会在分叉处打结。

### 编辑用绝对定位的 `<textarea>` 覆盖层，不用 `foreignObject`

`foreignObject` 在 Safari 里对 `textarea` 的滚动、IME 候选框定位都有问题，中文输入法尤其明显（候选框会飘到屏幕左上角）。

做法：`<textarea>` 作为 `position: absolute` 的兄弟节点放在容器里，位置由 `toWorld()` 把节点的世界坐标换算成屏幕坐标后 `left/top/width/height`。字号乘 `viewport.zoom`，这样输入时看到的字和节点上的字一样大。

键盘契约：`Enter` 提交、`Shift+Enter` 换行、`Esc` 取消（恢复原标题）、失焦提交。

### 分层 + memo，把重渲染边界切在「视口」和「文档」之间

结构：`boundaries → edges → relationships → topics → overlay`。

`EdgesLayer` 和 `TopicsLayer` 都是 `memo`，props 只依赖 `layout` / `theme` / `selection` / `editingId`。视口变化只影响外层 `<g transform>`，不触发这两层重渲染。

这一条是实测出来的，不是设计时想到的：第一版把 2000 个节点直接写在 `MindMapViewer` 的返回值里，每次 wheel 都重建 2000 个元素，单次事件 300ms+，滚轮像在拖水泥。切出 memo 层之后：

| 操作 | 2001 节点 |
| --- | --- |
| 打开（命令到节点出现） | 1016ms（含首帧布局，预算 1500ms） |
| 平移，平均 / 最大 | 17ms / 22ms |
| 缩放，平均 / 最大 | 39ms / 62ms |

`TopicNode` 自己也是 `memo` + 自定义 `areEqual`（比 `box` / `style` / `lines` / `selected` / `editing` 的引用），所以改一个节点的标题只重渲染那一个。

### 文字颜色按 WCAG 相对亮度自动选

`#FDD835`（黄色）配白字完全读不出来。`resolveStyle` 里加了一条兜底：如果整条解析链上**没人显式设过** `textColor`，就按 `fill` 的相对亮度选黑或白（阈值 0.5，用 sRGB 线性化后的加权和，即 WCAG 的 relative luminance）。

配套改动：`create.ts` 里删掉了主题角色样式里硬编码的 `textColor`。留着它的话，`assigned` 集合里永远有 `textColor`，兜底永不生效。

注意这里区分了「显式设为 `null`」和「没设」：`null` 是有效值（表示「跟主题走」），`undefined` 才是「继承」。这个区分靠 `apply()` 里的 `assigned: Set<keyof ComputedStyle>` 记录。

## Consequences

- 只读验收（docs/08 §4.2 #8）通过：预览模式下 `svg[data-read-only="true"]` 存在、新增按钮 0 个、`textarea` 0 个、双击不出现输入框、Tab+Enter 不改变节点数，而缩放（111%）与折叠（6 个）仍然可用。
- 主题切换不需要重建文档：`topic.style` 里只存显式设过的字段，其余全部由 `resolveStyle` 算出来，换主题即换色。
- 内联样式让导出可行，但也意味着「改样式」必须走 React 重渲染，不能靠切换 class。M3 如果要加「高亮某条路径」这类临时视觉效果，得走独立的 overlay 层，不能改节点属性。
- `memo` 的 `areEqual` 依赖 `layout` 的引用稳定：任何一次布局重算都会让全部节点重渲染。这是可以接受的——布局重算本身就意味着文档变了。
- 已知限制：折叠徽标超过 99 显示 `99+`，因为再长会撑破节点宽度；`TopicShape` 的 10 种形状都是手写 path，M3 加新形状要同步改这里和 `docs/03` 的形状枚举。

## Alternatives considered

**`<canvas>` 渲染**：2000 节点性能更好，且天然没有 DOM 数量问题。放弃原因是可访问性（canvas 里没有可聚焦元素，键盘导航、读屏全废）、导出（要自己实现 SVG 导出）、以及命中测试要手写空间索引。SVG 在 2000 节点这个量级够用。

**CSS 类 + 主题变量**：DOM 更干净，主题切换只需换根节点 class。放弃原因是导出——序列化后的 SVG 丢样式，而这个渲染器同时承担导出职责。

**`foreignObject` 包 `contenteditable`**：文字排版最自然（自动折行、自动高度）。放弃原因是 Safari 的 IME 候选框定位问题，中文用户会立刻踩到。

**每个插件用 `addEventListener` 绑到具体节点上**：更直观。放弃原因是 2000 节点 = 2000 组监听器，且节点增删时要同步解绑。统一用事件委托 + `data-topic-id` 属性查找，一个容器监听器解决全部。

**`readOnly` 布尔开关控制插件内部行为**：实现最少。放弃原因是「只读页面能编辑」这类 bug 一旦出现就是安全事故，而「插件没挂载」是结构上不可能发生。
