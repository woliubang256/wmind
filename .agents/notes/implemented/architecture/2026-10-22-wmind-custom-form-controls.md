# Agent Note: 表单控件全部改成自绘（下拉 / 复选 / 单选 / 滚动条）

Status: implemented

## Problem

深色主题下，原生控件的弹层和这个站点不是一套东西：

- `<select>` 的弹层由**操作系统**绘制。Chromium 在 macOS 上画一块方角、系统灰、
  带系统阴影的面板，圆角、字号、配色、间距一概不跟主题走。同一个页面里，
  卡片是 `rounded-2xl` 的、输入框有品牌色焦点环，只有下拉弹出来像另一个程序。
- `<input type="checkbox">` / `type="radio"` 的圆角、尺寸、勾线粗细、选中色
  只能靠 `accent-color` 调，方框形状改不动，深色下的对比度也不受控。
- 原生 `<option>` 里塞不进图标、右侧补充说明、分组标题——导出对话框的
  「倍率 2×」这类选项只能写成一串纯文字。
- 滚动条是系统画的长条方块，和圆角卡片放在一起很突兀。

## Decision

在 `components/ui/` 里**手写** shadcn 那三个控件的外观与交互，不引 Radix：

| 控件 | 做法 |
| --- | --- |
| `Select` | 触发器 `role="combobox"` + portal 弹层 `role="listbox"`，选项 `role="option"`，活动项走 `aria-activedescendant` |
| `Checkbox` | `role="checkbox"` 的 button，方框与勾都是自己画的 |
| `RadioGroup` | `role="radiogroup"` + `role="radio"`，漫游焦点（整组一个 Tab 停靠点，方向键换人） |
| 滚动条 | 只换**画法**（`::-webkit-scrollbar` + `scrollbar-width/color`），不动滚动机制 |
| `Textarea` | 保持原生 `<textarea>`——shadcn 的 `Textarea` 也是原生元素加样式 |
| `input[type=color]` | 保持原生，理由见下 |

不引 Radix 是因为项目早就拍板「组件自己写」（docs/02 §UI 组件：未引入 Radix/shadcn）。
引它等于一次性带进十几个包、一套 `asChild` 约定和一层 peer 依赖，而我们要的只是
三个控件的**长相**——交互语义按 WAI-ARIA 自己补，代码量比读它的文档少。

四处关键实现：

1. **弹层 portal 到最近的 `<dialog>`，不是 `document.body`。** `<dialog>` 被
   `showModal()` 提升到 top layer，盖在所有普通层之上——portal 到 body 的弹层会
   被对话框整个盖住，用户看到的是「点了没反应」。导出对话框里有四个下拉，这条
   不写就等于四个全废。
2. **焦点用回调 ref 交给弹层，不用 `useEffect([open])`。** 弹层要等落点算出来才
   挂载，`open` 变 true 的那一帧 `listRef.current` 还是 null；effect 先跑、节点后到，
   焦点留在触发器上，方向键于是被当成「再打开一次」，活动项原地不动。这个 bug
   是 e2e 抓到的（IE-M8-12 前后两次 `aria-activedescendant` 一模一样）。
3. **落点高度是估算的**（选项数 × 行高 + 内边距），不量真实 DOM。量真实高度要
   「先渲染再测量再挪位置」，中间那一帧会闪。选项一律 `nowrap` + `truncate`，
   估算与真实高度只差不到一像素。
4. **滚动条只改画法。** 换掉 `<ScrollArea>` 那类组件意味着每个滚动容器都要包一层、
   每个 `overflow` 都要重审，触屏与触控板的动量滚动也会变可疑。CSS 方案一行
   `::-webkit-scrollbar` 覆盖所有容器（对话框、面板、虚拟化列表、表格），
   滚轮/键盘/`scrollIntoView` 全部还是原生的。

`RadioGroup` 抽了 `plain` 与 `card` 两种形态：导出对话框是紧凑小圆点，设置页的
外观/语言是带图标与勾的卡片网格。原来设置页那两块是手写的 `role="radio"` 按钮，
**没有方向键**——只标 ARIA 不实现键盘是最常见的半成品，这次一起补上。

## Consequences

- 三处观感统一：登录页角落、编辑器面板、导出对话框用的是同一个 `Select`。
- 自绘就要自己补原生白送的东西，这些现在都有单测或 e2e 兜着：方向键 /
  Home / End（`nextEnabledIndex`、`edgeEnabledIndex`）、首字母跳转
  （`typeaheadIndex`）、空间不够时向上翻（`placeMenu`）、Esc 关弹层并还焦点、
  点外面关闭、`aria-activedescendant`。
- **e2e 要改三处**：`selectOption()` 用不了（不是 `<select>`），`.check()` 用不了
  （不是 `input`），`inputValue()` 用不了（不是表单元素）——所以触发器上挂了
  `data-value`，验收读属性而不是读可见文字（文字会被翻译、会被截断）。
- **`getByLabel` 是子串匹配**：`getByLabel('边框')` 在导出对话框里匹配到 8 个
  （编辑器面板的「边框宽度」「边框颜色」也算）。定位自绘控件要用
  `getByRole('combobox', { name, exact: true })`。
- `<label>` 包着 `<Select>` 时，label 的点击会转发给按钮（按钮是 labelable
  元素），所以点文字也能开下拉——但可访问名要显式给 `aria-label`，否则会变成
  「标签文字 + 当前值」拼在一起。
- `textarea` 仍是原生元素。多行文本的输入法候选框定位、选区、撤销栈、自动滚动
  全在内核里，换 `contenteditable` 之后中文输入会明显变差。要改的只是外观，
  这一层已经覆盖掉了。
- 取色器仍是 `<input type="color">`：自造 HSV 取色盘要处理色域、触屏拖拽、
  无障碍与键盘调值，代价远大于收益，旁边永远并排放着预设色块。

## Alternatives considered

- **引入 Radix + shadcn 生成组件。** 最省事，但项目已有的决定是「组件自己写」，
  而且 Radix 的 `Select` 带 Popper/floating-ui 一整条依赖链，为了三个控件不值得。
  真需要虚拟化长列表时再引也不迟。
- **保留原生 `<select>`，只给它套 `appearance-none` 与自定义背景。** 只能改
  **闭合态**的样子，弹层还是系统的——而弹层正是最刺眼的那部分。
- **自绘滚动条组件（`<ScrollArea>`）。** 见上：要藏原生滚动条、自己同步 thumb、
  自己处理拖拽与惯性，还要逐个容器改造，风险与收益不成比例。
- **用 `popover` 属性（HTML Popover API）让弹层自动进 top layer。** 确实能省掉
  「portal 到 dialog」这一条，但需要 `showPopover()` 与 `toggle` 事件配合，
  且定位仍要自己算；`<dialog>` 那条路已经在项目里用熟了。
