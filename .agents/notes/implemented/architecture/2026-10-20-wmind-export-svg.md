# Agent Note: 导出框架与独立 SVG（M4.6）

Status: implemented

## Problem

M4 的前半段只解决了「进得来」。要出得去，第一步是**把导出从画布里解耦**：

- 画布是为交互设计的——它读 store、挂事件、按视口变换坐标。导出不能拿这套东西：
  用户导出时可能正缩到 40% 看全局、平移到某个角落，带进导出图片就跟着歪。
- 导出需要「一张图里放下多个画布」，而画布一次只显示一个。
- 导出还必须**自包含**。用户把 SVG 拖进 Keynote、发到群里、当邮件附件——那时
  `/uploads/file_xxx.png` 是死链，外链图在断网那边也是死链。
- 验收标准里有一条「导出的 PNG 与画布所见像素级一致」。任何「另写一份差不多
  的渲染逻辑」的方案，在第一条分歧出现时就已经输了。

## Decision

### 导出不复用视口，重新跑一遍布局

`buildExportContext` 对每个画布调 `layoutMindmap({ sheet, theme })`。它是纯函数，
输出只取决于内容。于是「导出尺寸」与「用户当前缩放」彻底无关。

### 包围盒从盒子算，不用 `layout.bounds`

`layout.bounds` 含布局自己的 80px 内边距。导出留白是另一个独立参数，两者叠加时
用户把留白调成 0 之后仍会看到 80px 空边——表现是「选项没生效」。`contentBounds`
从盒子与连线端点直接算，留白完全由导出选项决定。连线端点也计入：曲线会鼓出盒子
外面一点，只算盒子会把弧顶裁掉。

### 用 `renderToStaticMarkup` 序列化，不用 `XMLSerializer`

把画布的三个图层（`EdgesLayer` / `TopicsLayer` / `BoundariesLayer` /
`RelationshipsLayer`）从 `mind-map-viewer.tsx` 抽到 `viewer/layers.tsx`，导出与
画布**共用同一批组件**。导出画布 `ExportCanvas` 与画布的差异只有三处，全是
「成品不该带编辑器痕迹」：不画折叠徽标（`showBadges={false}`）、不画选区与
编辑框、坐标不经过视口变换。

`renderToStaticMarkup` 在 node 环境下就能跑，所以「导出的 SVG 里有什么」可以纯
函数断言——不需要 jsdom（本项目也没有 jsdom）。走 `XMLSerializer` 则需要一个
真实挂进文档的 `<svg>`，而对话框里那个只是预览图。

### `react-dom/server` 必须待在懒加载 chunk 里

它压缩后约 200KB / gzip 约 65KB，而绝大多数访客根本不会点「导出」。所以：

1. `ExportDialog` 用 `React.lazy`，只在 `exportOpen` 时挂载；
2. `vite.config.ts` 的 `manualChunks` 专门把它从 react chunk 摘出来。

第 2 条不是可选项。`manualChunks` 里原本有一条把 `react` / `react-dom` 及其传递
依赖一并归入 react chunk 的规则，`react-dom/server` 会被它吞进去——结果就是首屏
多下载 65KB，而 `React.lazy` 白做了。实测（生产构建）：react chunk 525.76 kB /
gzip 165.02 kB → 318.17 kB / 101.24 kB，`export-dialog` chunk 变成 211.59 kB /
65.78 kB。

匹配要写两种路径：`react-dom/server.browser.js` 是薄包装，真正的实现在
`react-dom/cjs/react-dom-server.browser.production.js`。只匹配前者等于没匹配。

### 图片内嵌拆成「收集 / 抓取 / 替换」三步

抓字节是异步的，构建 SVG 是同步的。合成一个 `await inlineAll(ctx)` 的话，对话框
每次改选项（`useMemo` 依赖选项）都要重新下载所有图片。拆开之后，映射表只在图片
集合变化时更新，重算 SVG 是纯内存操作：

| 步骤 | 函数 | 同步性 |
| --- | --- | --- |
| 收集 | `collectImageSources(ctx)` | 纯函数，去重、跳过 `data:` |
| 抓取 | `loadImageSources(sources)` | 异步，**并发**，每张 8 秒超时，模块级缓存 |
| 替换 | `applyImageSources(ctx, map)` | 纯函数，只换 `src`，不动尺寸与盒子 |

**并发而不是串行**：串行时总耗时是每张图之和，而一张挂死的外链会让后面本来秒回
的本地图全部排队。实测 `https://example.com/remote.png` 在无网环境里能挂几十秒，
串行版本的表现是「点了导出没反应」。

**8 秒超时**用 `AbortController` 而不是 `AbortSignal.timeout`：后者在旧 Safari 上
不存在，而导出是个「失败就要静默」的路径，不适合在这里抛异常。

**失败保留原地址**而不是删掉 `<image>`：删了只会在节点里留一块空白，还看不出
为什么；留着地址至少是条线索。同时在对话框底部明说「N 张图片未能内嵌」——默默
留着会让用户以为导出是完整的。

### 不挂「组件已卸载」的 `alive` 闸门

开发期 StrictMode 会把 effect 跑两遍（挂载 → 卸载 → 再挂载）。第一遍的清理函数
会在它的 promise 落地**之前**就把 `alive` 置 false，于是图抓回来了、状态却没更新，
导出的 SVG 里留着一堆死链。React 18 起卸载后 `setState` 不再告警也不泄漏，这道
闸门只带来了这个 bug，所以去掉。

## Consequences

- 新增 `frontend/src/editor/export/`：`context.ts`（选项与包围盒）、`export-canvas.tsx`、
  `svg.ts`（序列化 + 文件名）、`assets.ts`（图片内嵌）、`download.ts`。
- 新增 `frontend/src/features/editor/export-dialog.tsx`，编辑器头部多一个「导出」入口。
- `viewer/layers.tsx` 抽出 `EdgesLayer` / `TopicsLayer`，`mind-map-viewer.tsx` 瘦身；
  `TopicNode` 多一个 `showBadges` 开关。
- 首屏 react chunk 从 525.76 kB / 165.02 kB gzip 降到 318.17 kB / 101.24 kB。
- `vite.config.ts` 新增 `optimizeDeps.include: ['react-dom/server']`。不写的话，
  开发期第一次点「导出」会触发依赖重优化并强制刷新页面——用户手上的编辑状态直接
  没了。
- 前端 733 个测试，其中 `export.test.ts` 19 个、`assets.test.ts` 12 个。
- **多画布导出只有单元测试覆盖**。目前还没有「新增画布」的入口（M5 的多画布），
  浏览器里造不出两张画布的文档，只能靠 `export.test.ts` 的合成文档验证拼接与偏移。
- **PNG / JPEG 尚未实现**（M4.7）。`scale` 目前只写进 SVG 的 `width` / `height`，
  栅格化时才是真正的清晰度开关。

## Alternatives considered

**手写字符串拼 SVG**：能省掉 `react-dom/server` 那 65KB，但等于维护第二套渲染逻辑。
「像素级一致」的验收项会在第一次改样式时失效，而且失效得很安静——预览是对的，导出
是旧的。共用组件是唯一能长期成立的方案。

**导出时挂一个隐藏的 `<svg>` 到文档里，再 `XMLSerializer`**：多一次 DOM 往返、多
一份内存，还得处理「挂载时机」与「字体是否就绪」。`renderToStaticMarkup` 直接在
内存里产出字符串，且能纯函数测试。

**把 `react-dom/server` 留在 react chunk**：实现最简单，代价是每个访客多下载 65KB。
`React.lazy` 的意义就是「不用就不下载」，留着等于自相矛盾。

**图片全部转 base64 塞进文档（导入时）**：会让文档体积随图片线性膨胀，而列表页、
缩略图、搜索都不需要图片字节。存 URL、导出时再内嵌，是唯一不污染存储的选择。

**图片内嵌失败就整个导出失败**：一张失效的外链图不该让用户拿不到自己的导图。

**串行抓图**：一开始就是这么写的，理由是「避免把服务端的 20 次/分钟限流打满」。
实际上 `/uploads` 是静态文件回放，没有限流；而串行遇到挂死的外链会让整个导出卡住。
