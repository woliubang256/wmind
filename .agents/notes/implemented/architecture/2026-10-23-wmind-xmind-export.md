# Agent Note: XMind 导出（把自家模型写回 .xmind 包）

Status: implemented

## Problem

导入侧早就支持 `.xmind`（现代 `content.json` 与 XMind 8 的 `content.xml` 两条路径），
但**导出没有回头路**：用户把一张图导进 wmind，改完之后只能导出成图片或 Markdown，
再也变不回 XMind。而 XMind 是这条产品线上最可能的下游——别人发来一份 `.xmind`，
改完要发回去。

难点不在「打包一个 zip」，在四件事：

1. **写哪种格式**。XMind 8 与现代版是两套完全不同的 schema（XML + `styles.xml`
   引用 vs. JSON），写两套写入器的成本换不来什么。
2. **样式怎么落**。XMind 的主题体系与本项目不同，字段名与语义都不一样。
3. **概要 / 外框 / 联系挂在哪一层**。XMind 自己把它们放在特定层级，写在别处
   本项目读得回来、XMind 未必认得。
4. **图片必须内嵌**。节点图片的 `src` 可能是 `/uploads/…` 或外链，两种都只在
   站内有效。

## Decision

### 只写现代格式（`content.json`）

一个 zip，内含 `content.json`（全部画布）、`metadata.json`（工作簿信息）、
`manifest.json`（条目清单）、`resources/`（图片）。XMind 2020 之后的版本都能打开。

### 样式写解析后的值，不写「继承」

[分支与边框映射修复](../bug-fix/2026-10-24-wmind-xmind-connection-mapping.md)统一标准读写字段并为旧 wmind 包增加来源兼容。导出测试除本项目往返外，直接解压断言标准属性，避免读写两端同时出错仍通过测试。

每个主题都写 `layout.styles` 里已经算好的 `ComputedStyle`——形状、填充、文字色、
字号、边框、连线。留着 `null` 让 XMind 套它自己的主题，导出的图会从彩色变成一片
灰白，而用户导出是为了给别人看「我画的这张图」。

代价明确：**导出后在 XMind 里换主题不会生效**（每项都是显式值）。这是刻意的取舍，
不是漏做。

### 不写 `fo:font-family`

本项目存的是族标识符（`sans` / `serif` / `mono`），不是字体名。硬猜一个字体名
（`NeverMind`、`Microsoft YaHei`）会写出一个在对方机器上未必存在的引用；而导入侧的
`normalizeFontFamily` 又会把它降级并报一条警告——「导出再导入」反而比不写更吵。
留空由 XMind 决定更诚实。

### 附属结构挂在 XMind 自己的层级上

概要挂**父主题**（`topic.summaries`）、外框挂**共同父主题**、联系挂**画布**
（`sheet.relationships`）。写在画布级也能被本项目读回来（读写两级是既有约定），
但 XMind 打开时未必认得。

外框的归属**必须等整棵树走完才知道**：`parentOf` 是在遍历里填的，所以
`groupBoundaries` 跑在根节点构建之后，再由 `attachBoundaries` 回填。第一版把外框
直接内联在 `topicToXmind` 里，结果是「走到 A 的时候还不知道 A1、A2 是不是都在 A 下面」。

### 图片内嵌是硬要求，与「是不是图形格式」无关

导出对话框原有 `plainText` / `visual` 两个开关。加 xmind 时**不能**用 `plainText`
当「不用算图」的条件——`.xmind` 里没有图就是一堆死链。因此新增第三个判定
`isDocumentFormat`（`DocumentExportFormat = 'xmind'`），并让 `visual = !structural`：

| 开关 | md / opml | xmind | svg / png / jpeg / pdf |
| --- | --- | --- | --- |
| `plainText`（预览换成文本、不抓图） | 是 | 否 | 否 |
| `structural`（倍率/留白/边框不适用） | 是 | 是 | 否 |
| `visual`（建 SVG、内嵌字体、查位图尺寸） | 否 | 否 | 是 |

调用方先把图片换成 `data:` URL，`xmind.ts` 解出字节写进 `resources/`，`src` 写成
`xap:resources/<name>`。换不回来的图**不写**，由调用方如实计数——写一个指回本机
的地址，文件到了别人手里就是一张破图。

### 预览是一份大纲，不是一张图

`.xmind` 的预览给 `<pre>` 大纲（`xmindOutline`）：节点数 + 缩进树。画成图会让人
以为导出的是一张图，画成 Markdown 会让人以为导出的是 Markdown。

## Consequences

- **顺带修掉一个真 bug**：`model/validate.ts` 的 `parseTopic` 只解析 `children`，
  `summaries` / `boundaries` 两个字段被静默丢掉。任何文档走一遍校验（导入之后必走）
  都会丢注释——这是「导入的概要看不见」的根因之一，只是之前没被往返测试照出来。
  `parseSummary` 同时接受主题级形状（缺 `topicId` 时从所属主题补）。
- **多画布是支持的**：`.xmind` 的一个 `content.json` 能装多个 `sheet`，所以
  「内容范围」选择器在 XMind 下**保留**（Markdown / OPML 才收起）。这点与文本格式
  不同，容易顺手抄错。
- 往返测试 `xmind.test.ts`（21 条）覆盖：标题与层级、概要 / 外框 / 联系存活、
  图片落到 `resources/image-1.png`、样式值落地、多画布。
- 导出对话框的格式从 6 个变 7 个（`FORMATS` 增加 `mime` 字段给文本格式用）。
- `e2e/export.mjs` 增加 XMind 单选与「下载后解压校验 content.json」两步。
- 已知未做：不写 XMind 8 的 `content.xml`（老版本 XMind 打不开）；不写
  `theme`（用显式样式代替）；备注里的富文本降级为纯文本。

## Alternatives considered

- **写 XMind 8 的 `content.xml`。** 覆盖面更广，但那是另一套 schema，且样式要
  另写 `styles.xml` 并维护 id 引用表。两套写入器的维护成本，换来的只是「2018 年
  之前的 XMind 也能打开」——而导入侧已经有两条路径，说明用户群里老版本是少数。
- **把导入时的原始 zip 留着，导出时改几处再打包。** 听起来无损，但用户在 wmind
  里改过的结构、样式、注释都要重新映射回原文件的位置；一旦中途删过节点，
  原文件里就有一堆孤儿。从自家模型重写是幂等的。
- **样式写 `null` 让 XMind 套主题。** 见上，导出图会变灰白。
- **用 `plainText` 兼作「不用抓图」。** 会跳过 xmind 的图片内嵌，产出死链。
- **预览画成一张 SVG 缩略图。** `.xmind` 没有「画出来」的样子，画一张图是骗人；
  而且为了预览去跑一遍布局 + SVG 构建，每次改选项几百毫秒。
