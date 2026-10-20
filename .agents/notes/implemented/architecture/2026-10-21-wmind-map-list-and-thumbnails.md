# Agent Note: 最近列表、回收站与缩略图

Status: implemented

## Problem

M5 的第一批交付要补上「最近 → 新建 → 编辑 → 保存」这条闭环里唯一还断着的一环：
首页。改之前 `/` 上是一块写死的空态占位（`home.building` 那句「最近列表将在 M5
接入」），而 `GET /api/v1/maps` 从 M2 起就能分页、能按标题搜索——接口一直有，
界面一直没接。`/trash` 则是一个 `PlaceholderPage`。

把界面接上去的过程中撞到三个后端问题，都不是「加个页面」能绕过的：

1. **排序不存在**。列表只有 `ORDER BY updated_at DESC` 一条路径，而路线图里
   明写了「搜索、排序、分页」。前端做不了这件事——分页之后在客户端排序只会
   把当前页重排一遍，看起来像「排序坏了」。
2. **每次自动保存都会把缩略图擦成空串**。`UpdateMapWithVersion` 的 SET 列表里
   有 `thumbnail_url = sqlc.arg(thumbnail_url)`，而 `service.Save` 从来不填这个
   字段（自动保存手里没有缩略图）。也就是说：只要缩略图功能上线，用户保存一次
   它就消失一次。这个 bug 一直藏着，因为没有缩略图的时候「擦成空串」看不出来。
3. **没有写缩略图的接口**。`domain.MapRepo.UpdateThumbnail` 和
   `UpdateMapThumbnail` 查询从 M1 就在，仓储契约测试也覆盖了，但 service /
   handler / 路由三层全缺。

## Decision

### 排序：每个顺序一条查询，不参数化

`queries/shared/maps.sql` 里 `ListMapsByOwner` / `ListMapsByOwnerName` /
`ListMapsByOwnerCreated` 三条，搜索侧同样三条（`SearchMapsByTitle*`）。
`domain.MapSort` 是枚举（`updated` / `title` / `created`），仓储层用 `switch`
挑一条**固定**语句，`sort` 永远不会被拼进 SQL。

先试过参数化，两条路都堵死：

- `ORDER BY CASE WHEN sqlc.arg(sort) = 'title' THEN ...` —— sqlc 的 SQLite 引擎
  不会重写 ORDER BY 表达式里的命名参数，生成的 Go 里 SQL 文本**原样留着**
  `sqlc.arg(sort)`，运行时 prepare 直接失败。换 `CASE sqlc.arg(sort) WHEN ...`
  也一样。
- `CAST(sqlc.arg(sort) AS TEXT)` 同样不被重写；而 `::text` 只有 PostgreSQL 认，
  这个文件两个引擎都要解析。

参数化排序另外还有个代价：`ORDER BY CASE` 让任何索引都失效。三条固定语句反而
更快，也更好读。

顺带补了 `id DESC` 作为最后一级排序键。`updated_at` 只有毫秒精度，批量导入
（几十张图落在同一毫秒）会产生并列，`LIMIT/OFFSET` 分页在并列上会**静默重复或
跳过**行——用户看到的是「第二页里有一张第一页见过的图」。

### 缩略图：从保存路径里彻底摘出来

`UpdateMapWithVersion` 不再写 `thumbnail_url`，`domain.UpdateMapInput` 里也删掉了
这个字段（留着就会有人再传一次空串）。缩略图走自己的 `PUT /api/v1/maps/:uid/thumbnail`，
body 是 `{ thumbnailUrl }`，空串表示清除。

service 只接受**站内相对路径**（以单个 `/` 开头，且不是 `//`）。这个字段会被
所有列表页渲染进 `<img src>`，让它只能指向本站是成本最低的一条防线；`//evil.com/x.png`
这种协议相对 URL 一并拒掉。

### 前端：判定与渲染分开

- `features/maps/thumbnail-plan.ts` —— 纯函数，零 DOM、零重依赖。
  `planThumbnail` 只缩小不放大，尺寸算不出来时返回 0（文档刚打开、布局未就绪是
  正常时机，不是错误）；`shouldRefreshThumbnail` 决定「这一刻要不要生成」。
- `features/maps/thumbnail-render.ts` —— 走导出那条路（`buildExportContext` +
  `ExportCanvas`），因为画布上的编辑框、选区、折叠徽标都要先摘掉，而导出上下文
  已经是纯几何。
- `features/editor/use-thumbnail-upload.ts` —— 渲染 → 上传 → 回写 → 刷缓存，
  **动态 import** 渲染模块。

刷新时机：没有缩略图必生成；有缩略图但本会话没保存过就什么都不做（打开看一眼
不该产生写入）；保存过且距上次生成超过 3 分钟再生成一次。

缩略图**不内嵌字体**，这是与导出对话框唯一的有意差异。内嵌要读几百 KB 分片并转
base64，而缩略图最宽 640px、正文 4~8px 高，字体度量差 16% 在这里不到 1.5px。
为看不见的差异让每次生成多下载几百 KB 不划算。

## Consequences

- `GET /api/v1/maps?sort=title|created` 生效；未知取值回落到「最近修改」而不是
  422——排序是展示偏好，为它返回错误页只会让用户看到一页空白。
- 契约测试新增「map list sorting and thumbnail survives a save」：三个排序刻意
  给出三种不同顺序（created / updated / title 互不相同），并且回归验证
  「保存后缩略图仍在」。
- HTTP 层新增 `TestMapListSort` 与 `TestMapThumbnailRoundTrip`（含三个非法 URL
  的 422 与空串清除）。
- `features/maps/thumbnail-plan.test.ts` 11 条：极端长条不会算出 0 高（4000×2 按
  比例是 0.32px，四舍五入就是 0，canvas 拿到 0 就是空图）、NaN/负数/0 返回 0 尺寸、
  四种刷新时机各自一条。
- 界面验收 23 条全过（`/tmp/wmind-accept/d-maps.mjs`，不提交）：空态、卡片、
  三种排序、搜索、无结果空态、重命名、复制、删除、回收站、恢复、彻底删除、
  缩略图生成与回读、保存后缩略图仍在、首屏 24 张、加载更多、搜索时保持排序。
- 打包：`thumbnail-render` 单独成 chunk（0.62 kB），但它在首次生成时会拉起
  `raster` 那个 210 kB（gzip 65.59）的块——也就是 `react-dom/server`。代价是
  「第一次打开一张没有缩略图的图」多下载 65 kB，换来列表页不是一屏空白。之后
  浏览器缓存，且同会话不再生成。
- 已知缺口：缩略图只在**编辑器里**生成。通过 API 或导入创建的图，在第一次被
  打开之前列表上是占位图标。服务端渲染缩略图（IE-30）能补上，但它按路线图
  推迟了。
- 回收站里的卡片渲染成不可点容器（`href={null}`）：那些 uid 已经读不到，点进去
  只会得到「导图不存在」。

## Alternatives considered

**在客户端排序**：零后端改动。放弃原因是分页——把当前页 24 张重排一遍，翻页后
顺序就乱了，而用户会认为是排序坏了。

**把 `thumbnail_url` 留在保存入参里，由前端每次保存都带上**：改动最小。放弃原因
是自动保存每几秒一次，把缩略图塞进这条最热的路径意味着每次保存都要多带一个字段，
而且「客户端记得带」这件事迟早会有人漏。

**缩略图存成 `data:` URL 直接写进 maps 表**：省掉一次上传。放弃原因是列表接口
一页 24 张，每张多几 KB 的 base64 就是一百多 KB 的额外响应体，而这些字节完全
可以走静态文件缓存。

**给缩略图内嵌字体**：与导出行为完全一致。放弃原因见上——640px 宽的图上省下的
是看不见的差异，付出的是每次生成几百 KB 的下载。

**把「加载更多」只做成按钮、不做 IntersectionObserver**：代码更少。放弃原因是
列表页最常见的动作就是往下滚，滚到底发现没东西了、要再点一次，是很廉价但很
明显的粗糙感。
