# Agent Note: XMind 8 导入（M4.5）

Status: implemented

## Problem

XMind 8（经典版）的包结构和现代格式完全不同：没有 `content.json`，内容在
`content.xml`，样式在 `styles.xml`。M4.2 只认 `content.json`，所以用户拖进一个
`.xmind` 之后得到的是「认不出格式」——而 XMind 8 至今仍有大量存量文件。

三个层面的难点：

- **没有公开文档**。元素名、属性名、命名空间都是逆向出来的，且不同小版本之间
  对同一属性用过不同拼法。只认一种拼法，表现就是「有些文件的颜色读不出来」。
- **样式是引用式的**。节点上只有 `style-id`，真正的样式在另一个文件里；主题又是
  另一层引用（`sheet@theme` → `<master-styles><style type="theme">`）。任何一环
  断掉都只是「样式没了」，不会报错。
- **图片不在节点上**。XMind 8 没有 `topic.image`，图片只能插在备注富文本里
  （`<xhtml:img>`）。而备注 HTML 的白名单清洗会把 `<img>` 整段丢掉——不特殊处理
  就是静默丢图。

## Decision

### 语义复用现代格式的实现，只换「XML → 字段名」这一层

`legacy.ts` 里没有重写 id 查重、range 重映射、detached 提升、备注清洗：

- `./ids.ts`：`claimId` / `parseRange` / `remapRange` 从 `modern.ts` 抽出来共用；
- `./image.ts`：`xap:resources/*` 的定位、格式白名单、`ctx.asset()` 登记共用；
- `../html.ts`：备注白名单清洗共用。

两套格式的**语义**没有区别，只有编码方式不同。各写一份的下场是慢慢跑偏：现代
格式修了 id 冲突，XMind 8 那边还留着老 bug。

### 元素名按本地名匹配，属性名两种拼法都认

`xml.ts` 新增 `localName` / `childNamed` / `childrenNamed`（OPML 的私有版本一并
收编）。`xhtml:div` 与 `div` 是同一件事，前缀只取决于导出器当时绑定的命名空间。

属性别名表（`KEY_ALIASES`）处理 `fill-color` / `svg:fill`、`text-color` /
`fo:color`、`style-id` / `styleId` 这几组。**先归一成现代键名，再交给
`toPartialStyle`**——而不是让映射函数同时认识两套拼法，否则每加一个属性都要在
两个地方改。

`line-class` 是另一套体系（分支线型），单独映射：`bight`（XMind 8 对「圆角
折线」的拼写，是的，拼错了）与 `fold` 都归为 `elbow`。

### 备注里的图片提升为节点图片

`<notes><html><xhtml:img src="xap:resources/pic.png"/></html>`：

- 第一张 → `topic.image`，字节交给 `ctx.asset()` 等上传；
- 其余 → 计入 `image-skipped`。

不提升就等于丢图：`sanitizeNotesHtml` 的标签白名单里没有 `img`，整段会被丢掉，
而界面上不会有任何提示。只取第一张是因为本模型的 `Topic` 只有一个 `image` 字段
——硬塞多张需要改数据模型，那是另一个量级的改动。

### 样式读不出来不阻断导入

`parseLegacyStyles` 内部 `try/catch`，失败返回 `failed: true` 并给一条
`styles-ignored`；`content.xml` 照常解析，只是节点上没有显式样式（继承主题）。
这是 docs/06 §2.1.4 与路线图风险表早就定好的降级策略：样式是装饰，缺了不该让
用户重来一遍。

主题同理：只还原 `map-properties` 的背景色，其余沿用默认主题；`sheet@theme`
查不到时给 `palette-fallback`。

### 格式探测：现代优先

`content.json` 记 1 分，`content.xml` 记 0.95 分。两者都在时按现代格式读——
XMind 2020 之后的包不会再带 `content.xml`，真同时出现说明是「另存为旧版」留下
的残留，按新的读更接近用户在 XMind 里看到的样子。

## Consequences

- `xmindAdapter.detect` 现在认两种结构文件；XMind 8 文件从「认不出」变成可导入。
- 新增 `xmind/legacy.ts`（~450 行）、`xmind/ids.ts`、`xmind/image.ts`；
  `modern.ts` 瘦身（图片与 id 逻辑移出），行为不变。
- `xml.ts` 多了三个通用工具，`opml.ts` 的私有版本删除。
- 前端 702 个测试，其中 `legacy.test.ts` 32 个、`index.test.ts` 新增 5 个端到端
  用例（含「两种结构文件都在时现代优先」）。
- **夹具是重建的，不是真实文件**。`legacy.test.ts` 里的 XML 按规范写，真实 XMind 8
  导出的属性拼法可能更杂。M4.11 验收前必须用 3~5 个真实样本（含自定义主题、图片、
  联系、外框、概要各一）替换并据实修正——这一点同时写进了 docs/06 §2.1.4。

## Alternatives considered

**给 `modern.ts` 加 if 分支，一套代码读两种格式**：两条解析路径的输入类型完全
不同（对象 vs XML 元素），合在一起会让每个字段都变成「先判断是哪来的」。分开
写、共用底层工具，比在一个函数里做两次类型分派干净。

**把 `styles.xml` 的属性名原样传给 `toPartialStyle`，让它同时认两套**：映射函数
会变成「两套键名 + 优先级」的迷宫，而且现代格式的测试要跟着改。在入口处归一，
下游只认一套，是最小改动面。

**备注里的图片保留在 `notes.html` 里**：白名单清洗会丢掉 `<img>`（这是有意的，
`<img>` 能发起外部请求）。放宽白名单等于把一个可追踪像素的入口重新打开。

**主题做完整还原**：XMind 8 的主题是一整套 master style（每个元素角色一份），
映射到本项目的 10 套调色板必然要「最接近匹配 + 回退」。先只还原背景色、其余
交给 `palette-fallback`，是诚实且可验证的中间态。

**不实现 XMind 8**：路线图把它列为交付物，且存量文件量很大。跳过等于让相当比例
的 `.xmind` 文件「看起来支持、实际导不进来」。
