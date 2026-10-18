# Agent Note: 导图持久化：只校验信封、乐观锁回读、跨用户一律 404

Status: implemented

## Problem

M2.6 要把编辑器里的文档存到服务端。表结构和仓储在 M0 就位了（`maps` 表、`domain.MapRepo` 19 个方法），这一批要定的是**接口层的取舍**：

- 服务端要不要把 `.wmind` 完整反序列化成强类型再校验？
- 自动保存每隔几秒一次，响应体回什么？
- 版本冲突怎么让前端知道「差多少」？
- 别人的 uid 试过来，回 403 还是 404？
- 客户端漏传版本号，算「冲突」还是「请求不合法」？

## Decision

### 服务端只校验「信封」，不校验文档内容

`service/map.go` 里的 `docEnvelope` / `docTopic` 只解 `format`、`formatVersion`、`sheets[].rootTopic`、`children.attached/detached` 这几层，够数节点、够拒绝明显不是导图的东西就停。

不定义完整 `Document` 类型是有意的：文档里样式、备注、标记、扩展字段的权威在**前端**。服务端每多解一层，就多一处「前端加了个字段，服务端旧版本把它抹掉了」的风险——而这正是自托管项目最不该有的耦合（用户可能只升级后端，或只升级前端）。

拒绝的条件只有四条：不是合法 JSON、`format != "wmind"`、没有画布、数不出节点。它们对应的是「这个请求根本不是一张导图」，而不是「这张导图的样式不对」。

**深度上限 512 不是洁癖**：`countNodes` 是递归的，一个精心构造的 10 万层嵌套会打爆 goroutine 栈。Go 的栈溢出是进程级崩溃，`recover` 兜不住——一个 PUT 请求能把整个服务带走。上限 512 已经远超正常导图深度（20 层就算深了）。

**大小上限 8 MiB**：2000 节点的图序列化后约 1.2 MB，8 MiB 是 6 倍余量。上限的意义不是省空间，而是让病态请求在读进内存前就被拒（`DOCUMENT_TOO_LARGE` / 413）。

### 保存响应不回文档

```go
type saveResultDTO struct {  // uid / version / nodeCount / updatedAt
```

自动保存每几秒一次，把 1 MB 的文档原样回传是纯带宽浪费——客户端本来就有那份文档，它需要的是「服务器现在到版本几了」。列表 DTO 同理不带 `document`：一页 20 张图就是 20 MB 响应体，而列表页只显示标题与缩略图。

详情 DTO 用 `json.RawMessage` 而不是 `map[string]any`：文档已经是校验过的合法 JSON，再解一次只是白花一次解析和一次分配。

### 冲突时回读当前版本

```go
if errors.Is(err, domain.ErrVersionConflict) {
    current, _ := s.maps.GetByUID(ctx, uid, ownerID)
    return apperr.New(CodeMapVersionConflict, "").
        WithDetail("currentVersion", current.Version).
        WithDetail("currentUpdatedAt", ...)
}
```

只回「冲突了」的前端只能弹一句「保存失败，请重试」——而重试必然再冲突，用户被卡死。带上 `currentVersion` 之后前端才能给出三个真实选项：用我的覆盖（拿 currentVersion 重发）、放弃我的改动（拉取服务器版本）、另存为副本。

`currentUpdatedAt` 是给「你的版本 14:32、服务器 14:35」这类文案用的。

### 跨用户访问一律 404

`MapRepo` 的每个方法签名都带 `ownerID`，查不到和不是你的都返回 `domain.ErrNotFound` → `MAP_NOT_FOUND`。

不做 403：403 等于确认「这张图存在」，可以被用来探测 uid 有效性。数据隔离靠签名强制，不靠调用方记得加条件。

### 漏传版本号是 422，不是 409

`version <= 0` 时直接 `VALIDATION_FAILED` + `fields.version`。

如果按 0 去匹配，它永远匹配不上，用户看到的是「这张图在别处被修改了」——排查方向立刻跑偏到并发上，而真正的原因是自己代码少传了字段。**让客户端 bug 表现为客户端 bug**。

### 回收站是软删除，清空才是硬删除

`DELETE /maps/:uid` 只写 `deleted_at`；`DELETE /trash/:uid` 与 `DELETE /trash` 才真删。所有读路径都带 `deleted_at IS NULL`，所以回收站里的图既不在列表里也读不到——想恢复必须走 `POST /trash/:uid/restore`。

### 顺手对齐的两处

- **`MapsPerUser()` 返回 0 表示不限**。写第一版时我按 100 兜底，查 `schema.go` 才发现 `limit.maps_per_user` 默认就是 0，而它的语义是「不限」而不是「一个都不许」。`Create` 里判 `limit > 0` 才算上限。
- **`ownerID` 必须用 `middleware.UserDBID`**。`middleware.UserID(c)` 返回的是对外 uid（字符串），而 `owner_id` 是 int64 外键。11 个 handler 一开始全写错，编译期才发现——这正是「领域层用内部主键、接口层用公开 uid」该有的表现。

## Consequences

- 单测：service 层 12 个（节点计数、标题兜底、非法文档、数量上限含 0=不限、超大文档、冲突回读、属主隔离、副本后缀与截断、LIKE 转义、回收站生命周期、未知导图、构造校验、错误映射）；HTTP 层 10 个（鉴权、创建→读→存往返、缺版本号、冲突回读、四类非法文档、跨用户 404、列表/搜索/重命名/复制、回收站全流程、空标题、未知 uid）。
- `go test ./...` 全绿，`gofmt` 与 `go vet` 干净。
- 已知限制：搜索在 SQLite 侧是 `LIKE`（只折叠 ASCII 大小写），PostgreSQL 侧是 `ILIKE`。中文都是精确匹配，ADR-015 已记录。
- 已知限制：没有缩略图生成（`thumbnail_url` 字段留着但恒为空），M3 的导出链路会补。
- 已知限制：`Purge` 走的是无条件 `HardDeleteMap`，对不在回收站里的图也生效。当前路由只从回收站页面调用，所以没加前置判断——但这是个隐含契约，接分享/API 时要补。

## Alternatives considered

**把 `.wmind` 定义成完整的 Go 类型（和前端 schema 一一对应）**：类型安全，服务端也能做深度校验。放弃原因是双向锁死——前端改一个字段要先改后端，而这套文档格式在 M3（导出、模板、AI 生成）还会变。信封校验拿到了 95% 的价值（拒绝垃圾输入），成本是 5%。

**版本号用 `If-Match: <etag>` 而不是请求体字段**：更符合 HTTP 语义。放弃原因是前端已经有 `version` 字段在状态里，塞进 header 反而要额外拼一层；而且 `details.currentVersion` 这种结构化冲突信息本来就得放响应体，两边不对称会让调试更麻烦。

**冲突时直接返回服务器整份文档，让前端自己 diff**：省一次 GET。放弃原因是自动保存是热路径，冲突不是——真冲突时多一次 GET 完全可接受，而把 1 MB 文档塞进错误响应里会让「错误日志」变得难以阅读。

**软删除直接复用 `maps` 表的 `status` 字段**：少一个时间戳。放弃原因是「什么时候删的」本身就是回收站页面要显示的信息（「3 天前删除」），`deleted_at` 一列同时承担状态和文案两个职责。

**列表接口返回 `document` 以便前端做缩略图**：省一次请求。放弃原因是响应体大小。缩略图应该是服务端生成的独立字段，而不是让列表页拉全量文档自己画。
