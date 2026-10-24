# Agent Note: Markdown 与 OPML 导入（M4.3）

Status: implemented

## Problem

M4 的第三批是两种纯文本格式。它们不像 XMind 那样有 zip 和一堆样式要还原，看起来「解析一下就好」，但四个地方各自会把结果做坏：

- **XML 解析器是自己的**。`fast-xml-parser@5` 带 6 个传递依赖，而它唯一的用途是读**不可信输入**。更麻烦的是实体展开：`<!DOCTYPE ... [<!ENTITY lol ...>]>` 一旦被支持，billion-laughs 与 XXE 就从「配置问题」变成「必须有配置」。
- **Markdown 的大纲结构是「行」的序列**，不是可以递归匹配的语法树。用一条大正则去抓标题，代码块里的 `#`、表格里的 `|`、列表里的 `-` 会互相污染。
- **层级跳跃**（`#` 直接接 `###`）如果按「深度差补中间层」，用户会看到一串空节点，以为文件缺内容。
- **列表缩进**用 `indent / 2` 算层号，在 4 空格缩进的文件里会凭空多出一倍层数。

## Decision

### 自研 XML 解析器，靠「跳过 DOCTYPE」把 XXE 变成结构上不可能

`xml.ts` 约 300 行，只做需要的子集：元素、属性、文本、自闭合、注释、CDATA、5 个预定义实体 + 数字实体。

关键决定是 **`<!DOCTYPE ...>` 整个跳过**（包括 `[...]` 内部子集，按 `[`/`]` 嵌套计数）。既然自定义实体永远没有被定义的机会，`&lol2;` / `&x;` 就只会原样留在文本里——**不是「拒绝展开」，而是「没有展开这件事」**。`xml.test.ts` 里专门用 billion-laughs 与 XXE 两份夹具断言 `&lol2;` / `&x;` 保持字面量，而不是断言「抛错」：抛错说明代码里存在一条展开路径，只是被挡住了。

另外两道闸门是 `maxDepth`（256）与 `maxNodes`（20 万），防止「合法但极深/极宽」的 XML 把调用栈打穿。

不认识的实体**保留字面量**而不是报错：真实世界的大纲文件里偶尔有 `&nbsp;`，为了它整份文件导入失败不值得。

### Markdown：先分词，再建树，模式判定照抄公式

`tokenizeMarkdown()` 逐行产出 `heading / item / quote / code / table / text / blank` 七种令牌。代码围栏先于标题匹配，所以块内的 `#` 不是标题；表格按「连续的 `|` 开头行」整块吃掉，分隔行丢弃。

模式判定直接照抄 docs/06 §2.2 的公式（`headingCount >= 2 && headingCount >= listCount / 2`），并在测试里钉住两个边界值。阈值 2 的用处：`# 待办` 下面挂一串列表，那是**列表写的大纲**，用列表层级更贴近原意。

这条数量公式由[混合标题保留修复](../bug-fix/2026-10-25-wmind-markdown-heading-preservation.md)取代：列表多的需求文档因此丢掉所有分类标题。现有代码以实际 heading 令牌存在性判定，围栏与转义文本不参与；本节保留原启发式的动机，不再作为当前契约。

两处实现细节：

- **层级跳跃不补空节点**：弹出条件写成 `top.level >= newLevel`，所以 `#` → `###` 直接挂到 `#` 上。
- **列表层级用栈比缩进，不算层号**：`while (top.indent >= indent) pop`。这样 2 空格与 4 空格的文件得到**同一棵树**，混排（0 → 4 → 2）也自然回到最近的上级。制表符按 4 空格计。

### 行内元素单次扫描

`` `code` `` / `![alt]（src）` / `[text]（url）` 用**一条 alternation 正则**一次扫完，而不是三次 `replace`。三次 replace 的写法下，`` `[a]（b）` `` 会先被抽出代码、再被第二步当成链接。单条正则按出现顺序匹配，天然正确——`parseInline` 的测试里专门有一条守这个。

`stripEmphasis()` 只处理 `*` 与 `~~`，**不处理 `_`**：`foo_bar_baz` → `foobarbaz` 比「保留了下划线」糟糕得多。

### 独占一行的图片提升为子主题

docs/06 §2.2 的表里写「图片 → 写入 `image`」，但只写这一行会漏掉最常见的形态：一行一个 `![]（...）`。它是个 `text` 令牌，按普通段落写进 `notes.plain` 的话——备注不渲染 Markdown——图片**彻底消失，连警告都没有**。

所以：行内解析出图片且**没有其他文字、没有行内代码**时，提升成子主题，标题取 `alt`（比 `(未命名)` 有信息量）。行内夹着图片的句子仍按段落处理，不拆节点。

相对路径的图片暂记 `image-skipped`：`image` 存的是 URL，相对路径必须先上传，而 `POST /api/v1/files` 还不存在（M4.2b）。写进文档只会是一张破图。

### OPML：元素名忽略大小写，空与坏分开判

XML 区分大小写，`xml.ts` 的 `childOf` 也严格比对；但存量 OPML 里确实有老导出器写 `<OPML><BODY><OUTLINE>`。`opml.ts` 里另写 `childNamed` / `childrenNamed` 忽略大小写——放宽的代价只是多认几个元素，收益是这类文件不会变成「空文档」。

**「空」与「坏」是两种失败**：不是 `opml` 根 / 没有 `body` / 没有 `outline` → 返回**空 sheets**，交给框架判 `EMPTY_DOCUMENT`；XML 结构错误 → 抛 `XmlParseError`，由适配器收口成 `PARSE_FAILED`。判断只在一个地方做。

### 探测优先级：OPML 必须高于 Markdown 的内容推断

`text-adapters.ts` 把两种格式的探测放在一起，就是为了让优先级在一个文件里看得见：

| 信号 | 分数 |
| --- | --- |
| zip | 0（那是 XMind 的地盘） |
| 头部 `<opml` | 0.95 |
| 扩展名 `.opml` / `.xml` | 0.7 |
| 扩展名 `.md` / `.markdown` | 0.75 |
| Markdown 内容特征累加 | ≤ 0.8 |

内容推断**封顶 0.8**，给「真的是 OPML」留出超过它的空间。反方向的闸门也必要：`<?xml` / `<opml` / `<html` 开头一律不判 Markdown——一个 `<opml>` 文件被 Markdown 抢走，会变成一堆带尖括号的空节点，用户看不出哪里错了。

`builtins.test.ts` 专门验跨格式路由（三种格式各走对适配器、扩展名写错但内容对、zip 但不是 XMind → `UNKNOWN_FORMAT`），因为选错适配器比解析失败更难查：文件「导入成功了」，但内容是错的。

### `markers.ts` 从 xmind 子目录提到 import 根目录

XMind 的 `markerId`、OPML 的 `_status` / `_priority` / `_icon`、Markdown 的任务列表都要落到同一套标记。三处各写一份对照表必然走岔，所以提取成 `import/markers.ts`。测试里额外钉住「一个 markerId 只能属于一个分组」——否则反查表会静默取到最后写入的那个。

## Consequences

- 新增 `frontend/src/editor/import/xml.ts`（自研 XML 解析器）、`markdown.ts`、`opml.ts`、`text-adapters.ts`、`markers.ts`（从 `xmind/mapping.ts` 提出）。
- 新增 126 条测试：`xml.test.ts`（24）、`markdown.test.ts`（41）、`opml.test.ts`（26）、`text-adapters.test.ts`（16）、`markers.test.ts`（7）、`builtins.test.ts`（12，跨格式路由）。全量 `vitest run`：**625 / 625**（40 个文件）。
- `builtins.ts` 的清单变成 `[xmindAdapter, opmlAdapter, markdownAdapter]`，`importAcceptAttribute()` 相应变成 `.xmind,.opml,.xml,.md,.markdown`。原来写在 `xmind/index.test.ts` 里的两条注册断言已移到 `builtins.test.ts`——注册清单不属于 XMind 适配器。
- `tsc --noEmit` 干净；`vite build` 通过（editor chunk 仍 97.24 kB，导入模块还没接进页面，整块被 tree-shake 掉）。
- 同步更新：docs/03 §5.4（`_status` 补 `canceled`/`cancelled`、`text` 回退规则、元素名忽略大小写）、§5.6（补代码块/表格行、独占一行图片的规则、层级跳跃与 `_` 两条说明）；docs/06 §2.2（两处实现细节）、§2.3（自研解析器与不用 `fast-xml-parser` 的理由）。
- **`image-skipped` 会一直触发**，直到 M4.2b 提供 `POST /api/v1/files`。这是如实上报，不是待修 bug。
- **XMind 8 仍走不到**：`detect` 只认 `content.json`。M4.5 补解析器时必须同时改 `detect`，否则「解析器写了但不可达」。

## Alternatives considered

- **用 `fast-xml-parser`**：少写 300 行。代价是为一个只读不可信输入的解析器引入 6 个传递依赖，且实体展开变成「必须配置对」而不是「结构上不存在」。
- **遇到未知实体就报错**：更严格。代价是真实文件里一个 `&nbsp;` 就让整份大纲导入失败。
- **XML 标签名全局忽略大小写**：一处改动就够。代价是把 `xml.ts` 从「通用解析器」变成「OPML 专用」，将来 XMind 8 复用时会带上不该有的宽容。
- **Markdown 用一条大正则抓标题**：代码最短。代价是代码块里的 `#`、表格里的 `|`、列表里的 `-` 互相污染，且失败形态是「多出几个奇怪节点」——最难查的那种。
- **层级跳跃时补空节点**：结构上更「规整」。代价是画布上一串空框，用户以为文件缺内容。
- **列表层级用 `indent / 2`**：不用维护栈。代价是 4 空格缩进的文件层数翻倍，而 4 空格是最常见的写法之一。
- **三次 `replace` 抽行内元素**：代码更好读。代价是代码片段里的 `[a]（b）` 被当成链接——`parseInline` 的测试专门守这条。
- **`_` 也当强调标记**：更符合 CommonMark。代价是 `foo_bar_baz` → `foobarbaz`，比保留错误标记糟糕得多。
- **独占一行的图片写进备注**：零额外代码。代价是图片静默消失且无警告。
- **OPML 空与坏都返回空 sheets**：少一个错误码。代价是「文件损坏」被报成「文件是空的」，用户不知道该换文件还是该修文件。
- **Markdown 内容推断不封顶**：能让更多无名文件被认出。代价是 `<opml>` 文件可能被 Markdown 抢走，产出一堆带尖括号的空节点。
