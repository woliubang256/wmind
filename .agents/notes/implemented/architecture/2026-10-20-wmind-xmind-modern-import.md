# Agent Note: XMind 现代格式导入（M4.2）

Status: implemented

## Problem

M4 的第二项是 XMind 导入，现代格式（`content.json`）先做，XMind 8（`content.xml` + `styles.xml`）留到 M4.5。这一批要解决的问题不是「把 JSON 读出来」——那是最容易的部分——而是**每一处「原样搬过来」都会在别处出问题**：

- **id 直接搬**：XMind 里重复 id 很常见（复制粘贴、合并文件），而 `parseDocument` 查重时会**换掉** id。换了之后 `relationships` / `boundaries` 里的引用就全指向不存在的老 id，联系线静默消失。
- **`children.detached` 直接搬**：`layout/` 只遍历 `children.attached`，detached 里的节点拿不到布局盒——**导入成功，节点不见了**。
- **字体名直接搬**：XMind 存的是「源机器上装了什么」的字体名，写进 `.wmind` 等于把一份必然失效的引用固化进存档（IE-25 明令不得残留原始字体名）。
- **备注 HTML 直接搬**：`realHTML` 是完整 HTML 片段，今天没人渲染它，明天谁写一句 `dangerouslySetInnerHTML` 就继承一个 XSS 面。
- **`structureClass` 直接搬**：XMind 的类名（`org.xmind.ui.logic.right`）写进文档后，渲染层一个都认不出来。

## Decision

### id 先查重，再拿映射修引用

`claimId()` 维护 `原 id → 写入文档的 id`。冲突时**保留第一次出现的映射**：后来的同名节点换新 id，但引用指向前者——用户拖出来的联系线连着的是先画的那个节点。

转换顺序是死的：**先把子树转完，再处理 `boundaries` / `summaries`**。range 里的 id 要等子树都进了映射表才解析得出来；反过来做的话，所有外框和概要都会因为「引用不到节点」被丢掉。

`range` 支持三种形态：`"(a,b)"`、`"a"`、`["a","b"]`。指向不存在节点的引用直接丢弃（留着只会让渲染层画零长度线）。

### `children.detached` 提到 `floatingTopics`

这是本次唯一一处**刻意偏离 docs/03 §5.2**（原文写「同名直传」）的地方，已同步改文档。

原因：`layout/mindmap.ts` 只处理 `sheet.floatingTopics`，从不读 `children.detached`。同名直传的结果是「导入成功、节点消失」——比报错难查得多。XMind 的 detached 语义本来就是「自由主题」，本模型有 `floatingTopics` 这个布局一等公民槽位，放进去既保住内容也保住语义。

**遗留**：`Topic.children.detached` 在模型里仍然存在但渲染层不支持。要么布局补上，要么从模型里删掉，别让它继续当「看起来支持、实际不显示」的陷阱。

### 主题：先认领配色，再叠加显式样式

XMind 主题是一堆 SVG/CSS 属性分组，本项目使用校准过对比度的内置配色。直接拿 XMind 的颜色当调色板，就绕过了 `check:palette`（文字至少 4.5:1）——用户看不出「为什么这张图在某些显示器上字看不清」。

所以分两步：

1. `matchPalette()` 用 `multi-line-colors` 里的分支色与 19 套可见配色及 2 套隐藏兼容配色比集合重合度，`≥ 0.5` 就认领那一套。**只看颜色不看背景**：内置配色背景都是白的，把背景算进去等于所有非白底主题都匹配不上，而背景本来就会在第二步被显式覆盖。
2. `toPartialStyle()` 把 XMind 明写的属性叠到角色样式上。

认领失败时回退到默认配色并记 `palette-fallback`——docs/06 §2.1.3 的原话。

### 字号 pt → px

XMind 用 `pt`，本项目用 `px`。不换算的话 XMind 默认的 `24pt` 中心主题会变成 24px，比本项目默认的 30px 明显小一圈，「导入结果看起来不像原来那张图」。按 1pt = 4/3 px 换算，24pt → 32px。

docs/03 §5.3 原文写的是「转数字」，换算仍然是「转数字」的一部分（单位归一），已在此记录。

### 字体名归一（docs/03 §5.3.1）

规则表按文档逐条实现，匹配顺序**有意义**：`serif` 必须排在 `sans-serif` 之后，否则所有无衬线字体会被判定成衬线。这条专门有测试。

不认识的字体名回退 `sans` 并记 `font-normalized`；楷体系（KaiTi / 楷体 / STKaiti / LXGW）降级为 `serif` 并额外标记 `degraded`——用户要能解释「为什么字变了」。

### 备注 HTML 过白名单清洗

新增 `import/html.ts`。**当前没有任何地方渲染 `notes.html`**（视图层只读 `notes.plain`），所以存原样也不会立刻出事——但正因如此，将来加渲染时没人会想起来补清洗。

策略是白名单 + 丢弃：标签只认固定集合（`p`/`strong`/`ul`/`li`/`a`…），属性只认 `<a>` 的 `href`/`title`，`href` 还要过协议白名单；`script`/`style`/`iframe`/`svg` 这类**连内容一起丢**（只丢标签会把 `alert(1)` 留成可见文字）。

文本节点原样透传不重新转义：源里的 `&amp;` 已是转义态，再转一次会变成 `&amp;amp;`，用户看到字面的 `&amp;`。

`href` 校验先做实体解码与空白剥离再判协议——`java&#x73;cript:` 与 `java\tscript:` 是两个经典绕过，都有测试。

### 图片：如实计入「未能还原」

docs/06 §2.1.3 要求把 `resources/` 里的图片上传到服务端（`POST /files`）再替换 `src`。后端目前只有 `/me/avatar`，没有通用上传接口，所以这一批**不写坏引用**（`xap:resources/a.png` 在浏览器里是破图），而是把 `image` 置空并记 `image-skipped` 计数。

任务 #64 补：后端 `POST /files` + `ImportResult.assets` + 异步上传后替换 `src`。解析保持同步是刻意的——`ImportAdapter.parse` 是纯函数，一旦引入网络请求，所有解析测试都要 mock fetch。

### 未识别字段只保留 `extensions`

docs/06 §2.1.3 说「未识别字段原样存入 `extensions`，导出时可回写」。**本项目没有 XMind 导出**（M4 的导出是 SVG / PNG / JPEG / PDF / Markdown / OPML），所以「回写不丢信息」这条前提不存在；把每个节点的每个未知键都塞进 `extensions` 只会让文档膨胀。因此只保留 XMind 自己的 `extensions` 字段。

如果将来要做 XMind 导出，这条要重新评估。

## Consequences

- 新增 `frontend/src/editor/import/xmind/`：`index.ts`（适配器）/ `modern.ts`（解析）/ `style.ts` / `fonts.ts` / `mapping.ts` / `theme.ts` / `properties.ts`。
- 新增 `frontend/src/editor/import/html.ts`（备注 HTML 白名单清洗）与 `builtins.ts`（内置适配器清单）。
- 新增 116 条测试：`modern.test.ts`（27）、`fonts.test.ts`（47，逐条对应 §5.3.1 的表）、`theme.test.ts`（14）、`index.test.ts`（10，真 zip 端到端）、`html.test.ts`（18，全是攻击样本）。前端总计 501 条 / 34 个文件。
- `registry.ts` 里的空 `importRegistry` 单例移除，改由 `builtins.ts` 导出——注册表本身保持无副作用，测试继续用 `createImportRegistry()` 新建。
- docs/03 §5.2 的内容映射表按实现重写：`children.detached` 改为提到 `floatingTopics` 并附理由；`notes.html` 补「过白名单清洗」；`relationships`/`boundaries`/`summaries` 补引用修正规则；`collapsed` 补 `branch: "folded"` 写法。
- 已用 `parseDocument()` 做二次闸门：导入结果不产生 `document-normalized` 警告（有测试守着），说明适配器产出的字段全部合法。
- **XMind 8 仍未支持**：`content.xml` 的 zip 探测返回 0，用户会看到「认不出格式」。M4.5 补上时要把 `detect` 一起改，否则「探测为 0、解析器却存在」永远走不到。

## Alternatives considered

- **`children.detached` 同名直传**（照文档原文）：零改动。代价是节点静默消失。
- **id 交给 `parseDocument` 查重**：少写 20 行映射代码。代价是所有引用在 id 被换掉后失效，而且失败是静默的。
- **把 XMind 的颜色直接当调色板**：还原度最高。代价是绕过对比度校验，且 `check:palette` 的结论对导入文件不成立。
- **主题对不上时不提示**：少一条警告。代价是用户以为「配色导入丢了」，实际是回退了。
- **备注 HTML 原样存**：零成本。代价是给未来埋一个 XSS 面，而「当前没人渲染」恰恰是最容易被忘记的理由。
- **备注 HTML 只保留纯文本**：最安全、代码最少。代价是长备注的排版全丢，而备注往往是 XMind 用户写得最多的部分。
- **字号不换算 pt→px**：少一处魔法数。代价是导入后整体小一圈。
- **图片写 `xap:` 相对引用**：看起来「保住了数据」。代价是画布上一堆破图，比没有图更像 bug。
- **把未知字段全塞进 `extensions`**：符合 docs/06 原文。代价是没有 XMind 导出可回写，纯膨胀。
