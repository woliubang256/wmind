# Agent Note: 导入对话框与入口（M4.4）

Status: implemented

## Problem

M4.1~M4.3 写完了三套适配器和一层安全框架，但它们**没有任何入口**——四个提交的代码在页面上完全不可达。这一批要把它接到首页，并处理「接到页面上」才会出现的问题：

- **解析是同步的**。`importRegistry.run()` 一口气跑完，50MB 的 zip 在主线程上要几百毫秒到一秒多。直接 `await file.arrayBuffer()` 之后立刻调用，用户看到的是「点了没反应，然后突然弹出结果」——「正在解析」那行字根本没有机会画出来。
- **`file.arrayBuffer()` 不是免费的**。先读再判大小，等于为了报一个「文件太大」的错先把 2GB 吃进内存。
- **拖放会吃掉页面的文字拖拽**。不判断 `dataTransfer.types` 就把整页做成投放区，用户会发现选中的文字拖不动了。
- **摘要可能是谎言**。适配器自报「我导入了备注」太容易与实际不符，而对话框上那个勾会让用户相信内容都在。
- **站点开关 `importEnabled` 早就存在**（`/site/config` 已返回），但没有任何地方消费它。

## Decision

### 先判大小，再读文件

`file.size` 是免费的。超过 `maxInputBytes` 直接在 UI 层给出与 `FILE_TOO_LARGE` 同一句文案，不进入 `arrayBuffer()`。框架里那道闸门保留（别的调用方可能没有这一层），但用户不该为「文件太大」付出读盘与内存的代价。

### 解析前让出一帧

```ts
setPhase({ kind: 'parsing', fileName: file.name });
const bytes = new Uint8Array(await file.arrayBuffer());
await new Promise<void>((resolve) => { setTimeout(resolve, 0); });  // 让「正在解析」画出来
const result = importRegistry.run({ fileName: file.name, bytes });
```

`setTimeout(0)` 而不是 `requestAnimationFrame`：要的是「让 React 提交一次渲染」，rAF 在后台标签页会被节流到不触发，而用户恰恰可能在切回来的时候等这个对话框。真正的解法是把解析放进 worker，那是 M6 的事——现在就把同步解析包装成看起来异步，是为了**不假装**它能并发。

### 拖放只在真的拖文件时接管

```ts
const hasFiles = (event) => config.importEnabled && event.dataTransfer.types.includes('Files');
```

`dragleave` 还要判断 `currentTarget.contains(relatedTarget)`：子元素之间移动也会触发 `dragleave`，不判断的话遮罩会闪。

### 摘要从最终文档反推

`summarizeImport()`（M4.1 已有）扫的是产出的文档，`import-present.ts` 只做文案。于是对话框上的每一项都可核对：

- 「已还原」= 文档里真的存在该字段（备注非空、labels 非空、image 非 null…）；
- 「未能还原」= 适配器显式上报的 `unsupported`；
- 「需要注意」= `warnings`。

三条互不重叠：**丢了**（unsupported）、**降级了**（warnings）、**拿到了**（restored）。

### 文案层单独成文件，测试拿真实语言包当翻译器

`import-present.ts` 是纯函数集合（`importErrorMessage` / `importWarningText` / `summaryRows` / `unsupportedRows` / `restoredLabels`），`t` 由参数注入。测试用 `zh-CN.json` / `en-US.json` 拼一个翻译器，断言「没有 `MISSING:`、没有未替换的 `{{占位符}}`」——这样「界面引用了一个不存在的 key」在单测里就暴露，而不是等用户看到一行 `import.dialog.something`。

不认识的错误码走通用文案，**不拼假 key**：`ImportError.code` 是字符串，任何适配器都能抛出没登记过的值，直接 `t('import.error.' + code)` 会把 key 原样显示给用户。

### 顺手修掉一个只在报错时才看得见的 bug

`toMessageParams()` 的白名单是「`size` / `limit` 是字节」，但 `TOO_MANY_TOPICS` / `TOO_MANY_ENTRIES` 用的也是 `limit`——于是文案变成「节点数超过上限（**19.5 KB** 个）」。

修法不是把 `count` 也加进白名单（那会让真正的字节数不被格式化），而是**把「个」类的上限参数改名为 `max`**：`limit` 专指字节，`max` 专指个数。三个 throw 点、四条文案、两处测试同步改。

### 导入模块按需加载

`features/dashboard/pages.tsx` 用 `React.lazy(() => import('./import-dialog'))`，并且**只在打开时才挂载**。首屏 index chunk 从 137.84 kB 回落到 86.35 kB，导入相关的 49.31 kB（gzip 16.59）单独成块。

### 摘要对话框不做「导入后自动进编辑器」

必须先给用户看摘要，尤其是「未能还原」那一段。直接跳进编辑器的话，用户会以为导入 100% 成功，等到发现贴纸全没了时已经找不到原因。

### 文件与文本共用解析、摘要和创建流程

导入入口使用「文件导入 / 文本导入」两个 Tab，默认文件导入。文本输入用 UTF-8 编码成字节，以 `.md` 文件名交给 `importRegistry.run()`，继续遵守字节、主题数和标题长度上限，不能直接调用 Markdown 解析器绕过防护。空白输入禁用解析。

切换 Tab 保留原始文本并回到对应输入界面；解析、图片上传和创建期间禁用 Tab，避免跨来源确认。关闭、卸载或开始新任务时失效旧运行编号，文件读取、上传进度、解析结果及创建回调均不得回写旧界面。已经发送的单张上传请求无法撤回，但失效任务不再发出后续上传，也不能创建导图。页面拖入文件始终进入文件 Tab。

## Consequences

- 新增 `frontend/src/features/dashboard/import-dialog.tsx`（对话框 + 摘要）、`import-present.ts`（纯文案层）、`import-present.test.ts`（14 条）。
- 首页新增「导入导图」按钮、页面级拖放、以及 `importEnabled` 开关判断；`components/ui/icon.tsx` 增加 `upload` 图标。
- `import.*` 命名空间新增 25 条 `dialog.*` 文案（中英各一份）。
- `TOO_MANY_TOPICS` / `TOO_MANY_ENTRIES` 的参数由 `limit` 改为 `max`，`format.ts` 的白名单注释同步说明「为什么 `limit` 只能是字节」。
- 全量测试 **639 / 639**（41 个文件）；`tsc --noEmit` 干净。
- 浏览器实测（Playwright，真实后端 + 真实注册/登录）：
  - Markdown：`plan.md` → 摘要「画布 1 个 / 主题 14 个（最大层级 6）/ 已还原 备注·标记 / 需要注意 表格已降级」→ 创建 → 编辑器渲染 14 个节点；
  - 未知格式：`junk.bin` → 「认不出 junk.bin 的格式，目前支持 XMind、Markdown 与 OPML。」+「换一个文件」回到投放区；
  - XMind：`plan.xmind` → 摘要「主题 5 个（最大层级 3）/ 已还原 结构·备注·标签·标记·折叠状态」→ 编辑器结构为「逻辑图（向右）」，折叠节点带折叠标记。
- 文档同步：docs/02 / 05 / 06 / 09 里关于 `fast-xml-parser` 的描述全部改为自研解析器；docs/06 §2.1.5 补摘要的「需要注意」段、入口说明、主线程解析与按需加载的理由。
- `frontend/e2e/import-tabs.mjs` 使用接口夹具验证 22 项：文件/文本双入口、空白禁用、切换保留文本、中英与窄屏、键盘 Tab 语义、摘要确认后创建，以及关闭文件读取/图片上传后的旧任务隔离，不写开发数据库。导入文案、Markdown、注册表和语言包相关单测共 81 项通过。
- 粘贴文本省去保存临时 `.md` 文件的操作，仍由原有摘要说明导入结果；UTF-8 编码需要额外一份字节缓冲，大小闸门在编码后按真实字节数判断。解析仍在主线程同步运行，Tab 在解析/上传/创建阶段暂时禁用。关闭后已经发出的上传可能完成，但旧结果不再进入摘要，后续图片不再发起上传。

## Alternatives considered

- **解析放进 Web Worker**：不卡主线程。代价是 `ImportResult` 要可结构化克隆（文档对象没问题，但 `warnings` 里的 `cause` 链不行），且 worker 与主线程要共享 `fflate` 的一份代码。M6 再说，现在先把同步解析「诚实」地包成异步。
- **不先判大小，交给框架报错**：代码更少。代价是 2GB 的文件先被读进内存。
- **整页都做投放区，不判断 `types`**：实现更简单。代价是页面内的文字拖拽被吃掉。
- **导入后直接跳编辑器**：少一次点击。代价是用户看不到「未能还原」，丢了什么永远不知道。
- **摘要用适配器自报的统计**：少一次遍历。代价是对话框可能说谎，而说谎的 UI 比没有 UI 更糟。
- **把 `count` 加进字节白名单**：一处改动。代价是真正的字节数（`size`）也会被当个数——方向反了。正确做法是让参数名各自承担唯一语义。
- **对话框静态引入**：少一层 `lazy`。代价是每个打开首页的人都先下载三种格式的解析器和 fflate。
- **`requestAnimationFrame` 让出渲染**：语义更准。代价是后台标签页里 rAF 不触发，对话框会一直停在空白。
- **文本入口直接调用 `parseMarkdown`**：不需要构造虚拟文件名和 UTF-8 字节，代码路径更短。但会绕过注册表的尺寸、归一化和最终主题数闸门，使同一份内容因入口不同而受到不同防护，因此文本仍经过注册表。
