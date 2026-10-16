# wmind 后端设计与 API 规范

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 编写日期 | 2026-10-16 |
| 状态 | 待评审 |
| 技术栈 | Go 1.23 · Gin v1.10 · PostgreSQL 16 · pgx v5 · sqlc · golang-migrate |
| 关联文档 | [02-系统架构设计](./02-系统架构设计.md) · [03-数据模型与文件格式](./03-数据模型与文件格式.md) |

---

## 1. 分层约定

```
HTTP 请求
   │
   ▼
[ middleware ]  认证 → 限流 → 请求 ID → 日志 → 恢复 → CORS
   │
   ▼
[ handler ]     绑定参数、校验格式、调用 service、包装响应
   │            ✗ 不含业务规则   ✗ 不直接访问数据库
   ▼
[ service ]     业务规则、权限校验、事务边界、跨仓储编排
   │            ✗ 不感知 gin.Context   ✗ 不拼 SQL
   ▼
[ repository ]  执行 SQL、映射领域对象
   │            ✗ 不含业务判断
   ▼
[ PostgreSQL ]
```

### 1.1 硬性约束

| 约束 | 理由 |
| --- | --- |
| handler 层禁止 import repository | 防止业务逻辑绕过 service 直接落库 |
| service 层禁止 import gin | 保证业务逻辑可脱离 HTTP 单测 |
| repository 禁止 import service | 防止循环依赖 |
| 所有导图相关查询必须带 `owner_id` 条件 | 从类型层面强制数据隔离 |
| 所有写操作在 service 层开启事务 | 事务边界唯一且清晰 |

### 1.2 依赖注入

不使用 DI 框架。`cmd/server/main.go` 中手工装配：

```go
cfg      := config.Load()
pool     := db.Connect(cfg.Database)
queries  := sqlc.New(pool)
store    := storage.NewLocal(cfg.Storage)

userRepo := repository.NewUserRepo(queries)
mapRepo  := repository.NewMapRepo(queries)
// ...
authSvc  := service.NewAuthService(userRepo, tokenRepo, cfg.Auth)
mapSvc   := service.NewMapService(mapRepo, settingSvc, store)
// ...
router   := httpapi.NewRouter(httpapi.Deps{Auth: authSvc, Map: mapSvc, ...})
```

手工装配在模块数量 < 20 时最清晰、可读性最好，且没有运行时反射。

---

## 2. 认证与授权

### 2.1 令牌方案

| 项 | 值 |
| --- | --- |
| 算法 | HS256（单实例场景足够；多实例共享密钥即可，无需 RS256 的密钥轮换复杂度） |
| Access Token 生命周期 | 15 分钟 |
| Refresh Token 生命周期 | 7 天（滑动续期：每次刷新后签发新令牌并作废旧的） |
| 密钥 | `WMIND_JWT_SECRET`，启动时校验长度 ≥ 32 字节，不足则拒绝启动 |

**Access Token Claims**：

```json
{
  "sub": "01JFA8Z3K5N7Q2R9T4V6W8X0Y1",   // user.uid
  "role": "user",
  "typ": "access",
  "iat": 1760000000,
  "exp": 1760000900,
  "jti": "01JFA8..."
}
```

**Refresh Token**：不透明随机串（32 字节 base64url），服务端存 SHA-256 哈希，支持按用户/设备撤销。

### 2.2 令牌传递方式

| 客户端 | Access Token | Refresh Token |
| --- | --- | --- |
| Web | `Authorization: Bearer <token>`，存内存（不落 localStorage） | `HttpOnly; Secure; SameSite=Lax` Cookie，路径 `/api/v1/auth` |
| 客户端 App（预留） | 同上 | 请求体字段 `refreshToken`，由客户端安全存储 |

`POST /api/v1/auth/refresh` 同时接受 Cookie 与请求体两种来源，Web 与 App 共用同一接口。

### 2.3 授权规则

| 规则 | 实现 |
| --- | --- |
| 需要登录的接口 | 挂载 `RequireAuth` 中间件 |
| 需要管理员 | 挂载 `RequireAuth` + `RequireRole("admin")` |
| 资源属主校验 | 在 service 层校验 `resource.owner_id == currentUser.ID`，不匹配返回 `MAP_NOT_FOUND`（**404 而非 403**，不泄露存在性） |
| 禁用用户 | `RequireAuth` 每次从数据库/缓存读取用户状态，`status != active` 返回 `AUTH_ACCOUNT_DISABLED` |

> **注意**：不在 JWT 里携带 `status`，否则禁用后需等令牌过期才生效。用户状态查询走 60 秒内存缓存，禁用操作主动失效缓存，保证「禁用即生效」。

### 2.4 密码策略

- 哈希：bcrypt，cost = 12。
- 最小长度由 `auth.password_min_length` 控制（默认 8），最大 72 字节（bcrypt 上限）。
- 不强制复杂度字符集（避免诱导弱密码模式），改为校验常见弱密码黑名单（内置 Top-1000 列表）。
- 修改密码后，撤销该用户**除当前设备外**的所有 refresh token。

---

## 3. 中间件链

顺序（自外向内）：

| 顺序 | 中间件 | 职责 |
| --- | --- | --- |
| 1 | `Recover` | 捕获 panic，记录堆栈，返回 `INTERNAL_ERROR` |
| 2 | `RequestID` | 生成 ULID，写入 `X-Request-Id` 与 context |
| 3 | `Logger` | 访问日志：方法、路径、状态码、耗时、用户 ID、requestId |
| 4 | `CORS` | 开发环境放开 `localhost:5173`；生产环境由 Nginx 同源代理，不开放跨域 |
| 5 | `RateLimit` | 按路由组应用不同限流策略（见 §3.1） |
| 6 | `RequireAuth` | 解析并校验 Access Token，注入 `currentUser` |
| 7 | `RequireRole` | 校验角色 |

### 3.1 限流策略

| 路由组 | 维度 | 限额 |
| --- | --- | --- |
| `POST /auth/login` | IP + 用户名 | 5 次 / 分钟，连续失败 5 次锁定 15 分钟 |
| `POST /auth/register` | IP | 3 次 / 小时 |
| `POST /auth/refresh` | IP | 30 次 / 分钟 |
| `POST /export` | 用户 | 10 次 / 分钟 |
| `POST /files` | 用户 | 20 次 / 分钟 |
| 其他已登录接口 | 用户 | 300 次 / 分钟 |
| 公开只读接口 | IP | 120 次 / 分钟 |

实现：`golang.org/x/time/rate` + 内存 LRU 桶。接口已抽象为 `Limiter`，多实例部署时替换为 Redis 实现即可，调用方无感知。

---

## 4. API 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `/api/v1` |
| 内容类型 | 请求与响应均为 `application/json; charset=utf-8`（文件上传除外） |
| 认证 | `Authorization: Bearer <accessToken>` |
| 资源标识 | 路径中使用 `uid`（ULID 字符串），不使用自增 ID |
| 时间格式 | RFC 3339 UTC，如 `2026-10-16T02:30:00Z` |
| 命名 | JSON 字段一律 `camelCase`；查询参数一律 `snake_case` |
| 分页 | 请求 `page`（从 1 开始）、`page_size`（默认 20，最大 100）；响应统一含 `pagination` 对象 |
| 排序 | `sort` 参数，格式 `field` 或 `-field`（前缀 `-` 表示倒序）；白名单校验 |
| 幂等 | 所有 `POST` 创建接口接受可选 `Idempotency-Key` 头 |
| 空值 | 不返回 `null` 数组，返回 `[]` |

### 4.1 成功响应

```json
{
  "data": { "...": "..." },
  "requestId": "01JFA8Z3K5N7Q2R9T4V6W8X0Y1"
}
```

列表响应：

```json
{
  "data": [ { "...": "..." } ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 137,
    "totalPages": 7
  },
  "requestId": "01JFA8..."
}
```

### 4.2 错误响应

```json
{
  "error": {
    "code": "MAP_VERSION_CONFLICT",
    "message": "该导图已在其他位置被修改",
    "details": {
      "currentVersion": 12
    }
  },
  "requestId": "01JFA8..."
}
```

- `code` 为大写下划线常量，前端据此做文案映射（**不要**依赖 `message` 做判断，它可能被本地化）。
- 校验失败时 `details.fields` 给出字段级错误：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "参数校验失败",
    "details": {
      "fields": {
        "email": "邮箱格式不正确",
        "password": "密码长度不能少于 8 位"
      }
    }
  }
}
```

---

## 5. 接口清单

### 5.1 公开接口

#### `GET /api/v1/health/live`

存活探针。永远返回 `200`。

#### `GET /api/v1/health/ready`

就绪探针。检查数据库连接，异常返回 `503`。

#### `GET /api/v1/site/config`

未登录可访问。前端启动时调用，用于决定是否显示注册入口。

```json
{
  "data": {
    "siteName": "wmind",
    "logoUrl": "",
    "description": "",
    "icp": "",
    "registrationEnabled": true,
    "emailVerificationRequired": false,
    "passwordMinLength": 8,
    "importEnabled": true,
    "exportEnabled": true,
    "userTemplateEnabled": true,
    "version": "1.0.0"
  }
}
```

### 5.2 认证接口

#### `POST /api/v1/auth/register`

```json
// 请求
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "********",
  "nickname": "Alice"
}
```

```json
// 201 响应
{
  "data": {
    "accessToken": "eyJhbGciOi...",
    "expiresIn": 900,
    "user": {
      "uid": "01JFA8...",
      "username": "alice",
      "email": "alice@example.com",
      "nickname": "Alice",
      "avatarUrl": "",
      "role": "user",
      "status": "active",
      "createdAt": "2026-10-16T02:30:00Z"
    }
  }
}
```

同时下发 refresh token Cookie。注册关闭时返回 `REGISTRATION_CLOSED`（403）。

#### `POST /api/v1/auth/login`

```json
// 请求
{ "identifier": "alice@example.com", "password": "********" }
```

`identifier` 同时接受邮箱与用户名。失败统一返回 `AUTH_INVALID_CREDENTIALS`（401），不区分「用户不存在」与「密码错误」。

#### `POST /api/v1/auth/refresh`

无请求体（Web 走 Cookie）或 `{ "refreshToken": "..." }`（App）。返回新的 `accessToken`，并轮换 refresh token。

#### `POST /api/v1/auth/logout`

撤销当前 refresh token，清除 Cookie。返回 `204`。

#### `GET /api/v1/auth/me`

返回当前用户完整信息，含统计：`mapCount`、`storageUsedBytes`。

#### `PATCH /api/v1/users/me`

```json
{ "nickname": "新昵称", "email": "new@example.com" }
```

修改邮箱需校验唯一性。

#### `POST /api/v1/users/me/password`

```json
{ "oldPassword": "********", "newPassword": "********" }
```

成功后撤销其他设备的会话。

#### `POST /api/v1/users/me/avatar`

`multipart/form-data`，字段 `file`。限制 2MB，仅接受 `image/png`、`image/jpeg`、`image/webp`。服务端裁剪为 256×256 并转 WebP。

### 5.3 导图接口

#### `GET /api/v1/maps`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `page` | int | 默认 1 |
| `page_size` | int | 默认 20，最大 100 |
| `q` | string | 标题模糊搜索 |
| `sort` | string | `-updated_at`（默认）\| `-created_at` \| `title` |
| `updated_since` | string | RFC 3339。**客户端增量同步预留**，返回该时间后更新的导图（含已删除标记） |

```json
{
  "data": [
    {
      "uid": "01JFA8...",
      "title": "产品规划",
      "thumbnailUrl": "/api/v1/files/01JFA9...",
      "nodeCount": 42,
      "version": 12,
      "createdAt": "2026-10-01T08:00:00Z",
      "updatedAt": "2026-10-16T02:30:00Z",
      "deleted": false
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 37, "totalPages": 2 }
}
```

> 列表接口**不返回** `document` 字段，避免响应体过大。

#### `POST /api/v1/maps`

```json
// 请求（从模板创建）
{
  "title": "未命名导图",
  "templateUid": "01JFA7...",     // 可选；与 document 二选一
  "document": { /* 可选，直接传入完整 .wmind 文档（导入场景） */ }
}
```

返回 `201` + 完整导图对象（含 `document`）。校验 `limit.maps_per_user`，超限返回 `MAP_LIMIT_REACHED`。

#### `GET /api/v1/maps/{uid}`

返回完整导图，含 `document`。他人资源返回 `MAP_NOT_FOUND`。

#### `PUT /api/v1/maps/{uid}`

全量保存（编辑器的自动保存走这个接口）。

```json
{
  "version": 12,
  "title": "产品规划",
  "document": { /* 完整 .wmind */ }
}
```

```json
// 200
{
  "data": { "uid": "01JFA8...", "version": 13, "updatedAt": "2026-10-16T02:31:00Z" }
}
```

版本不匹配返回 `409 MAP_VERSION_CONFLICT`，`details.currentVersion` 给出服务端当前版本，前端据此提示冲突。

#### `PATCH /api/v1/maps/{uid}`

仅改元信息（重命名），不动 `document`：

```json
{ "title": "新标题" }
```

#### `DELETE /api/v1/maps/{uid}`

软删除（进回收站），返回 `204`。

#### `POST /api/v1/maps/{uid}/duplicate`

复制导图，标题追加「 - 副本」。返回 `201` + 新导图。

#### `PUT /api/v1/maps/{uid}/thumbnail`

`multipart/form-data`，字段 `file`（PNG/WebP，≤ 512KB）。前端渲染首屏后上传。

#### `GET /api/v1/trash`

回收站列表，参数同 `GET /maps`。

#### `POST /api/v1/trash/{uid}/restore`

恢复导图。若同名冲突不处理（标题可重复）。

#### `DELETE /api/v1/trash/{uid}`

彻底删除（连带删除缩略图文件），返回 `204`。

#### `DELETE /api/v1/trash`

清空回收站。

### 5.4 模板接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/templates` | 参数 `category`（`basic` / `user` / 空=全部）。内置模板对所有用户可见；用户模板仅本人可见 |
| `POST` | `/api/v1/templates` | 从导图创建用户模板：`{ "name": "...", "mapUid": "..." }` |
| `PATCH` | `/api/v1/templates/{uid}` | 重命名 |
| `DELETE` | `/api/v1/templates/{uid}` | 删除用户模板；内置模板返回 `TEMPLATE_BUILTIN_READONLY` |

### 5.5 主题接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/themes` | 返回全部内置主题 + 当前用户自定义主题 |
| `POST` | `/api/v1/themes` | 创建自定义主题：`{ "name": "...", "config": { /* Theme */ } }` |
| `PUT` | `/api/v1/themes/{uid}` | 更新自定义主题 |
| `DELETE` | `/api/v1/themes/{uid}` | 删除；内置主题返回 `THEME_BUILTIN_READONLY` |

### 5.6 文件接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/files` | 上传图片（`multipart/form-data`，字段 `file`，参数 `kind`）。返回 `{ uid, url, width, height }` |
| `GET` | `/api/v1/files/{uid}` | 读取文件。公开可读（URL 含随机 uid，不可枚举）；若 `site` 要求鉴权则校验属主 |
| `DELETE` | `/api/v1/files/{uid}` | 删除（仅属主） |

### 5.7 服务端导出接口（大图兜底）

#### `POST /api/v1/export`

```json
{
  "mapUid": "01JFA8...",
  "sheetIds": ["sh-01"],
  "format": "png",              // png | jpeg | svg | pdf
  "scale": 2,
  "transparent": false,
  "border": "none",             // none | stroke | colored
  "showBranding": false,
  "showDate": false
}
```

响应 `200`，`Content-Type` 为对应类型，`Content-Disposition: attachment`。

- 由 Headless Chrome（`chromedp`）渲染前端导出的同一套 SVG 模板，保证前后端导出视觉一致。
- 超过 10 秒未完成返回 `504`，超时阈值可配置。
- `feature.export_enabled = false` 时返回 `EXPORT_DISABLED`。

> **一期策略**：常规导出走前端（零延迟、零服务端负载）；本接口作为超大导图与「服务端批量导出」的兜底，可延后到 M6 实现。

### 5.8 管理接口

全部要求 `role = admin`。

#### `GET /api/v1/admin/users`

| 参数 | 说明 |
| --- | --- |
| `page` / `page_size` | 分页 |
| `q` | 匹配用户名 / 邮箱 / 昵称 |
| `role` | `user` \| `admin` |
| `status` | `active` \| `disabled` \| `pending` |
| `sort` | `-created_at`（默认）\| `-last_login_at` \| `username` |

```json
{
  "data": [
    {
      "uid": "01JFA8...",
      "username": "alice",
      "email": "alice@example.com",
      "nickname": "Alice",
      "avatarUrl": "",
      "role": "user",
      "status": "active",
      "mapCount": 12,
      "storageUsedBytes": 1048576,
      "lastLoginAt": "2026-10-16T01:00:00Z",
      "createdAt": "2026-09-01T00:00:00Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 8, "totalPages": 1 }
}
```

#### `POST /api/v1/admin/users`

```json
{ "username": "bob", "email": "bob@example.com", "password": "********", "nickname": "Bob", "role": "user" }
```

#### `PATCH /api/v1/admin/users/{uid}`

```json
{ "nickname": "Bob", "email": "bob@example.com", "role": "admin", "status": "disabled" }
```

- 禁止把最后一个管理员降级：返回 `ADMIN_LAST_ADMIN`（409）。
- 禁用用户时立即撤销其全部 refresh token 并失效状态缓存。

#### `DELETE /api/v1/admin/users/{uid}`

| 参数 | 说明 |
| --- | --- |
| `map_strategy` | `delete`（连同导图一并删除，默认）\| `keep`（保留导图，转为无主） |

禁止删除自己（`ADMIN_CANNOT_DELETE_SELF`），禁止删除最后一个管理员。

#### `POST /api/v1/admin/users/{uid}/reset-password`

```json
{ "password": "********" }   // 省略则服务端随机生成
```

响应返回新密码（仅此一次），并撤销该用户全部会话。

#### `GET /api/v1/admin/settings`

返回全部设置项（扁平 key-value）。

#### `PUT /api/v1/admin/settings`

```json
{
  "site.name": "wmind",
  "auth.registration_enabled": false,
  "limit.upload_max_mb": 20
}
```

部分更新；未知 key 返回 `SETTINGS_INVALID`；类型不匹配返回 `SETTINGS_INVALID` 并指明字段。

#### `GET /api/v1/admin/stats`

```json
{
  "data": {
    "userCount": 8,
    "activeUserCount": 6,
    "mapCount": 137,
    "mapCountToday": 5,
    "storageUsedBytes": 524288000,
    "trend": [
      { "date": "2026-10-10", "newUsers": 1, "newMaps": 12 }
    ]
  }
}
```

#### `GET /api/v1/admin/audit-logs`

参数：`page`、`page_size`、`action`、`actor_uid`、`from`、`to`。

### 5.9 接口汇总

| 分组 | 数量 | 说明 |
| --- | --- | --- |
| 公开 | 3 | health ×2、site config |
| 认证与个人 | 7 | register / login / refresh / logout / me / password / avatar |
| 导图 | 12 | 列表、创建、读取、保存、重命名、删除、复制、缩略图、回收站 ×4 |
| 模板 | 4 | 列表、创建、改名、删除 |
| 主题 | 4 | 列表、创建、更新、删除 |
| 文件 | 3 | 上传、读取、删除 |
| 导出 | 1 | 服务端兜底导出 |
| 管理 | 10 | 用户 ×5、设置 ×2、统计、日志、… |
| **合计** | **44** | |

---

## 6. 错误码表

| HTTP | code | 说明 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 请求体格式错误 |
| 401 | `AUTH_INVALID_CREDENTIALS` | 账号或密码错误 |
| 401 | `AUTH_TOKEN_EXPIRED` | Access Token 过期（前端应触发刷新） |
| 401 | `AUTH_TOKEN_INVALID` | 令牌无效或签名错误 |
| 401 | `AUTH_REFRESH_INVALID` | Refresh Token 无效或已撤销 |
| 403 | `AUTH_ACCOUNT_DISABLED` | 账号已被禁用 |
| 403 | `AUTH_ACCOUNT_PENDING` | 账号待激活 |
| 403 | `AUTH_FORBIDDEN` | 无权限访问该接口 |
| 403 | `REGISTRATION_CLOSED` | 站点已关闭注册 |
| 403 | `MAP_LIMIT_REACHED` | 已达单用户导图数量上限 |
| 403 | `TEMPLATE_BUILTIN_READONLY` | 内置模板不可修改 |
| 403 | `THEME_BUILTIN_READONLY` | 内置主题不可修改 |
| 403 | `EXPORT_DISABLED` | 站点已关闭导出 |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在 |
| 404 | `MAP_NOT_FOUND` | 导图不存在或无权访问 |
| 404 | `TEMPLATE_NOT_FOUND` | 模板不存在 |
| 404 | `THEME_NOT_FOUND` | 主题不存在 |
| 404 | `FILE_NOT_FOUND` | 文件不存在 |
| 409 | `AUTH_EMAIL_TAKEN` | 邮箱已被占用 |
| 409 | `AUTH_USERNAME_TAKEN` | 用户名已被占用 |
| 409 | `MAP_VERSION_CONFLICT` | 导图版本冲突（并发保存） |
| 409 | `ADMIN_LAST_ADMIN` | 不能降级或删除最后一个管理员 |
| 409 | `ADMIN_CANNOT_DELETE_SELF` | 不能删除自己 |
| 413 | `DOCUMENT_TOO_LARGE` | 导图文档超过大小上限 |
| 413 | `FILE_TOO_LARGE` | 上传文件超过大小上限 |
| 415 | `FILE_TYPE_NOT_ALLOWED` | 文件类型不允许 |
| 415 | `IMPORT_FORMAT_UNSUPPORTED` | 导入格式不支持 |
| 422 | `VALIDATION_FAILED` | 参数校验失败 |
| 422 | `DOCUMENT_INVALID` | 导图文档结构非法 |
| 422 | `IMPORT_PARSE_FAILED` | 导入文件解析失败 |
| 422 | `SETTINGS_INVALID` | 设置项非法 |
| 429 | `AUTH_TOO_MANY_ATTEMPTS` | 登录尝试过多，已锁定 |
| 429 | `RATE_LIMITED` | 请求过于频繁 |
| 500 | `INTERNAL_ERROR` | 服务器内部错误 |
| 500 | `EXPORT_RENDER_FAILED` | 导出渲染失败 |
| 503 | `SERVICE_UNAVAILABLE` | 依赖服务不可用 |

---

## 7. 关键实现要点

### 7.1 导图保存事务

```go
func (s *MapService) Save(ctx context.Context, userID int64, uid string, in SaveInput) (*SaveResult, error) {
    return s.tx.WithTx(ctx, func(tx repository.Tx) (*SaveResult, error) {
        m, err := tx.Maps().LockByUIDAndOwner(ctx, uid, userID) // SELECT ... FOR UPDATE
        if err != nil { return nil, err }
        if m.Version != in.Version {
            return nil, domain.Conflict("MAP_VERSION_CONFLICT", m.Version)
        }
        if err := docmodel.Validate(in.Document); err != nil {
            return nil, domain.Invalid("DOCUMENT_INVALID", err)
        }
        m.Document = in.Document
        m.Title    = in.Title
        m.Version++
        m.NodeCount = docmodel.CountNodes(in.Document)
        m.SizeBytes = len(in.Document)
        return tx.Maps().Update(ctx, m)
    })
}
```

使用 `SELECT ... FOR UPDATE` 行锁 + `version` 乐观锁双保险：前者防止同一事务内的竞态，后者给出友好冲突提示。

### 7.2 文档校验

`docmodel.Validate` 在保存前执行，规则：

1. `formatVersion` 的 major 必须等于当前支持的 major。
2. `sheets` 非空，每个 sheet 恰好一个 `rootTopic`。
3. 所有 `id` 在文档内唯一（构建 ID 集合检测重复）。
4. `relationships` 的 `end1Id` / `end2Id`、`boundaries.range`、`summaries.range` 引用的主题必须存在。
5. 树深度 ≤ 64，节点总数 ≤ 20000。
6. 样式字段值必须在枚举范围内。

校验失败返回 `DOCUMENT_INVALID` 并附带具体路径（如 `sheets[0].rootTopic.children.attached[2].id duplicated`）。

### 7.3 用户状态缓存

```
RequireAuth → 查缓存（60s TTL）
                ├─ 命中 → 校验 status
                └─ 未命中 → 查库 → 写缓存
```

禁用用户 / 删除用户 / 改角色时调用 `userCache.Invalidate(uid)`，保证管理动作即时生效。

### 7.4 设置缓存

`SettingService` 在内存中持有全量设置（约 20 个 key），启动时加载，`PUT /admin/settings` 后整体重载。读操作无锁（`atomic.Value` 持有不可变快照）。

### 7.5 文件存储抽象

```go
type Storage interface {
    Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
    Get(ctx context.Context, key string) (io.ReadCloser, string, error)
    Delete(ctx context.Context, key string) error
    URL(key string) string
}
```

- `LocalStorage`：写入 `WMIND_STORAGE_DIR`，`URL` 返回 `/api/v1/files/{uid}`。
- `S3Storage`：兼容 MinIO / 阿里云 OSS / AWS S3，`URL` 返回预签名 URL 或 CDN 地址。二期实现，接口已就位。

### 7.6 优雅退出

```go
srv := &http.Server{Addr: cfg.Addr, Handler: router}
go srv.ListenAndServe()

<-ctx.Done()                                  // SIGINT / SIGTERM
shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
defer cancel()
_ = srv.Shutdown(shutdownCtx)                 // 等待在途请求完成
pool.Close()
```

容器 `stop_grace_period: 20s`，确保滚动更新时不丢请求。

---

## 8. 为客户端 App 预留的扩展点

本期不实现，但接口设计已就位：

| 预留项 | 已落地的设计 |
| --- | --- |
| 无状态认证 | Bearer Token + 请求体传 refresh token，不依赖 Cookie |
| API 版本化 | 全部接口在 `/api/v1` 下，破坏性变更走 `/api/v2` |
| 增量同步 | `GET /maps?updated_since=` 与列表项 `deleted` 标记 |
| 设备管理 | `refresh_tokens.platform` 字段 + `user_devices` 表已建 |
| 文档格式 | `.wmind` 为语言无关 JSON，客户端可直接复用同一 schema |
| 服务端导出 | 客户端算力有限时可直接调用 `/export` 取图 |
| 推送 | `user_devices.push_token` 字段预留 |

**二期需要新增**：`POST /auth/device`（设备注册）、`GET /sync/changes`（批量增量拉取）、`POST /sync/push`（批量上行变更）、WebSocket 通道（实时协作）。

---

## 9. 测试策略

| 层级 | 范围 | 工具 |
| --- | --- | --- |
| 单元测试 | `docmodel` 校验与遍历、`convert/*` 各格式双向转换、`auth` 令牌与密码 | `testing` + `testify` |
| 集成测试 | repository 的 SQL、service 的事务与权限 | `testcontainers-go` 起真实 PostgreSQL |
| 接口测试 | handler 的请求解析、状态码、错误码 | `httptest` + 表驱动 |
| 契约测试 | 响应结构与 `api/openapi.yaml` 一致性 | `kin-openapi` 校验响应 |

**重点测试用例**（与需求验收标准对应）：

1. 越权访问他人导图 → 404 `MAP_NOT_FOUND`。
2. 并发保存同一导图 → 后者 409 `MAP_VERSION_CONFLICT`。
3. 关闭注册后调用注册接口 → 403 `REGISTRATION_CLOSED`。
4. 禁用用户后其已签发令牌立即失效。
5. 删除最后一个管理员 → 409 `ADMIN_LAST_ADMIN`。
6. XMind 2020+ / XMind 8 / OPML / Markdown 四种导入样本的节点数与层级断言。
7. 含循环引用的非法文档 → 422 `DOCUMENT_INVALID`。
