# Agent Note: 导入框架与安全防护（M4.1）

Status: implemented

## Problem

M4 的第一项是「导入框架 | 适配器接口 + 注册表 + 导入对话框 | 2 人日」。三种格式（XMind 现代 / XMind 8 / Markdown / OPML）的解析逻辑差异极大，但如果每个适配器自己管「解压、计数、留痕、截断」，那 20 万节点的炸弹只要找到一个没加防护的适配器就能进来。[06 §2.1.2](../../../../docs/06-导入导出与主题系统.md) 列了六条安全防护（zip 炸弹、路径穿越、超大 JSON、节点爆炸、XML 实体注入、XSS），要落地得先回答四个问题：

- **解压在哪一层拦？** `unzipSync` 会一次性摊平整个包，「先解开再检查大小」等于已经中招了。
- **路径穿越靠过滤 `..` 够吗？** 靠正则去堵字符串，永远是「漏一个编码变体」的游戏。
- **适配器凭什么受上限约束？** 如果上限是模块常量、由适配器自己读，那约束力等于「适配器作者的自觉」。
- **错误与警告怎么跨语言？** 适配器里写中文，`en-US` 界面下就是漏翻；写英文，中文界面下更糟。

## Decision

### 只用固定文件名，不做路径拼接

`STRUCTURAL_ENTRIES` 是**精确集合**（`content.json` / `content.xml` / `styles.xml` / `metadata.json` / `manifest.json` / `meta.xml` / `META-INF/manifest.xml`），`bytes(name)` 先查集合再查 Map。图片走另一条路：`resources()` 只接受 `resources/` 前缀且 `isSafeEntryName()` 通过的条目。

这样「路径穿越」不是被过滤掉的，而是**结构上不可能**——条目名从头到尾只当过 Map 的键，没当过一次路径。`isSafeEntryName()` 仍然实现并测试了（拒绝 `..`、`/` 开头、`C:`、反斜杠、`\0`、空段、超长名），因为将来做「导入时把资源写进 IndexedDB 或本地目录」时它会变成真正的路径校验，那时候忘了加就是漏洞。

### 在 `filter` 里记账，超限就抛

fflate 的 `unzipSync(bytes, { filter })` 在解压**每个条目之前**回调，参数里有 `originalSize`（zip 头里声明的大小）。把累计字节数放在 filter 里加，超限直接 `throw`——fflate 会让异常透出来，此时炸弹条目还没被分配内存。

三个细节：

1. **只对接受的条目计费**。被拒绝的条目根本不解压，给它记账没有意义；而且 `resources()` 是第二次扫描，两边都记就会把同一批条目算两遍，合法文件被误杀。
2. **预算是跨扫描共享的**。结构扫描一次、`resources/` 一次，共用一个 `budget` 对象，总量仍受 200MB 约束。各算各的话实际峰值会翻倍——这条有专门的测试（结构 600B + 资源 600B，上限 1000B，第二次扫描必须失败），把 `budget` 改成 pass 内的局部变量会立刻变红。
3. **单条目上限只管被接受的条目**，`content.json` > 50MB 走 `ENTRY_TOO_LARGE`。

条目数另有 `maxEntries`（4096）上限，防的是「一百万个小文件」把条目名表撑爆——这类样本的压缩包只有几百 KB，只靠字节数上限拦不住。

### 上限注入，不读模块常量

`ImportLimits` 六个字段全部经 `resolveLimits(overrides)` 传进 `openZip()` 与 `createImportContext()`，适配器拿不到全局常量。测试因此可以在几十字节的样本上验证 200MB 的中止逻辑——不可能真造一个 1GB 炸弹再等它跑完。

`resolveLimits` 忽略 `NaN` / 负数 / `undefined`：`{ maxTopics: undefined }` 这种写法会让上限变成 `NaN`，而 `n > NaN` 恒为 `false`，等于**关掉**了上限。

### 节点上限有两道闸

`ctx.topic()` 是主闸，适配器每建一个节点调一次。但「适配器忘了调」是现实风险，所以 `run()` 在归一化之后用 `summarizeImport()` 再数一遍最终文档，超限同样抛 `TOO_MANY_TOPICS`。第二道闸晚一步（内存已经花了），但它挡的是**适配器 bug**，不是攻击者——攻击者不会让适配器忘记计数。

节点超限一律**抛错不截断**：截断会产出一份「看起来正常、实际少一半」的文档，用户保存一次就永久丢失。

### 警告与错误只带 code，不带文案

`ImportWarning { code, params }`、`ImportError { code, params }`，两个 code 集合都写成 `as const` 数组（`IMPORT_WARNING_CODES` / `IMPORT_ERROR_CODES`）而不是纯类型联合——它们要当运行时数据用：`format.test.ts` 逐条核对 `zh-CN` 与 `en-US` 有没有对应文案，并核对两边 key 集合完全一致。新增 code 忘了翻译会红，而不是在界面上露出 `import.warning.palette-fallback`。

`format.ts` 里的 `warningKey()` / `errorKey()` / `featureKey()` 是界面与测试**共用**的 key 拼接函数，两边不可能对不上。

参数里的字节数（`size` / `limit`）由 `toMessageParams()` 转成 `"50.0 MB"` 再插值，白名单式的（只转这两个名字），因为 `count` / `method` 也是数字，转成 `"3.0 B"` 就闹笑话了。

### 归一化闸门：适配器的产出必须再过一遍权威校验

`run()` 拿到适配器返回的文档后调 `parseDocument()`（`model/validate.ts`）。字段级修补会被记成一条 `document-normalized` 警告——那说明适配器有 bug，不该静默吞掉。结构性失败（不是对象、`format` 不对）则直接 `PARSE_FAILED`。

`sheets.length === 0` 在归一化**之前**判，抛 `EMPTY_DOCUMENT`：`parseDocument` 会给空文档自动补一张空画布，于是界面出现「导入成功但什么都没有」的导图，用户还会把它保存下来。

### 输入惰性化

`ImportInput.zip()` / `text()` 都是惰性的：50MB 的 XMind 一进来就 `TextDecoder.decode` 会吃掉 100MB+ 字符串，而 XMind 根本不需要文本形态；反过来 Markdown 不需要 zip。`zip()` 在 `looksLikeZip()` 为假时返回 `null` 而不是抛错（探测阶段本来就要处理「不是 zip」），但**结构损坏的 zip 会抛**——吞掉会让「压缩炸弹」被误报成「格式不认识」，用户永远不知道该换什么文件。

### 不引入 XML 解析库

原本计划加 `fast-xml-parser`。`npm view fast-xml-parser@5.11.2 dependencies` 显示它有 **6 个依赖**，其中 `is-unsafe`、`xml-naming`、`path-expression-matcher`、`@nodable/entities`、`fast-xml-builder` 都不是这个包历史上的依赖（v4.5.3 只有 `strnum`）。一个专门解析不可信输入的库突然多出五个陌生传递依赖，是典型的供应链风险信号。

M4.1 不需要 XML（OPML 在 M4.3、XMind 8 在 M4.5），所以本批不引入，留给那两个任务决定：要么手写一个只支持所需子集、**直接拒绝 `<!DOCTYPE`** 的解析器（比「配置一个通用解析器关掉外部实体」更强），要么用 `fast-xml-parser@4.5.3`。届时单独决策并记录。

zip 侧只引入 `fflate@0.8.3`：零依赖、MIT、8 KB 级别，`unzipSync` 的 `filter` 恰好提供了「解压前回调 + 异常中止」这个唯一能满足记账需求的原语。

## Consequences

- 新增 `frontend/src/editor/import/`：`types.ts` / `limits.ts` / `errors.ts` / `zip.ts` / `context.ts` / `registry.ts` / `summary.ts` / `format.ts` / `index.ts`。
- 新增 69 条测试：`zip.test.ts`（23，含真实 8MB 全零载荷在 4MB 上限处中止、两次扫描共享预算、路径穿越表）、`registry.test.ts`（18，含「适配器忘调 `ctx.topic()`」的兜底拦截）、`context.test.ts`（12，含代理对不被劈开）、`format.test.ts`（16，含两种语言 key 集合一致）。
- 做了一次变异验证：把共享 `budget` 改成 pass 内局部变量后，`zip.test.ts` 有 2 条立刻变红；把 `en-US` 的两条翻译删掉后，`format.test.ts` 有 3 条变红（含 key 集合比对）。两处都已还原。
- `frontend/package.json` 加 `fflate`。`pnpm-lock.yaml` 手工补了 3 处（importers / packages / snapshots），用 `pnpm install --frozen-lockfile --lockfile-only` 验证通过——本机沙箱拒绝 `pnpm add` 的 rename 操作，走的是「npm 下 tarball → 解到 `node_modules` → 手补 lockfile」这条路。
- `i18n` 两种语言各加 43 条 `import.*` 文案（10 错误 / 11 警告 / 7 不支持项 / 11 能力项 / 3 格式名 + `import.title`）。
- **导入对话框不在本批**。它需要「能真的导入一个文件」才有意义，因此放到三个适配器之后（任务 #63）。本批只把对话框要用的契约（code 集合、key 拼接、参数格式化、摘要结构）全部准备好。
- `unzipSync` 的 filter 只在 `content.json` 等白名单条目上解压，缩略图与附件不进内存；条目名清单仍然保留，用于诊断与「原文件包含附件」这类备注。
- 已知未覆盖：声明大小说谎的 zip（头里写 10KB、实际 deflate 出 1GB）。fflate 按声明大小预分配，这种包会在 inflate 阶段报错而不是爆内存，因此不需要额外闸门——但这条没有测试样本，属于「按实现推断」而非「已验证」。

## Alternatives considered

- **`JSZip`**（docs/06 原文写的库）：API 更友好，但体积大一个量级，且 `unzipSync` 的 `filter` + 异常中止语义更直接对应「解压前记账」这条需求。
- **`DecompressionStream('deflate-raw')` + 自己解中央目录**：零依赖。代价是 zip64、data descriptor、stored/deflate 混合、加密标志位都要自己处理，出错方式是「某些真实文件打不开」，很难在测试里覆盖全。
- **先整体解压再检查总量**：实现最简单。代价是炸弹在检查之前就已经把内存吃完了，等于没防。
- **用正则过滤条目名里的 `..`**：比白名单省事。代价是编码变体、`\0` 截断、绝对路径要逐个想到，而白名单根本不需要想。
- **上限用模块常量，适配器自己读**：少一层参数传递。代价是测试无法在小样本上验证 200MB 路径，且「某个适配器忘了查」无法被框架发现。
- **警告里直接写中文**：少一层 i18n。代价是英文界面漏翻，且同一 code 在多处触发时文案会分叉。
- **适配器产出直接交给渲染层**：省一次 `parseDocument()`。代价是适配器的一个字段笔误会在渲染层炸，报错点离原因十万八千里。
