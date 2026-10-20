# wmind 后端设计与 API 规范

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.3 |
| 编写日期 | 2026-10-16 |
| 状态 | 已确认（分享链接已纳入一期；邮件服务（SMTP）调整为二期；**数据库为 PostgreSQL + SQLite 双方言**，见 [09](./09-技术决策记录.md) ADR-015） |
| 技术栈 | Go 1.25 · Gin v1.12 · PostgreSQL 16（pgx v5）或 SQLite（modernc.org/sqlite）· sqlc · golang-migrate |
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
   │            ✗ 不含业务判断   ✗ 不感知具体方言（接口在 domain 层）
   ▼
[ PostgreSQL ] 或 [ SQLite ]     ← 由 WMIND_DB_DRIVER 选择，见 §7.9
```

### 1.1 硬性约束

| 约束 | 理由 |
| --- | --- |
| handler 层禁止 import repository | 防止业务逻辑绕过 service 直接落库 |
| service 层禁止 import gin | 保证业务逻辑可脱离 HTTP 单测 |
| repository 禁止 import service | 防止循环依赖 |
| 所有导图相关查询必须带 `owner_id` 条件 | 从类型层面强制数据隔离 |
| 所有写操作在 service 层开启事务 | 事务边界唯一且清晰 |
| **service 层禁止 import 任何 `repository/postgres` 或 `repository/sqlite`** | 只依赖 `domain` 中的仓储接口，保证方言可替换 |
| **新写 SQL 必须在双方言下等价**（或显式放入方言目录） | 防止只测一种方言导致的线上事故，见 §7.9.3 |

### 1.2 依赖注入

不使用 DI 框架。`cmd/server/main.go` 中手工装配。**数据库的装配按驱动分叉，其余代码零差异**：

```go
cfg := config.Load()

// ── 按驱动选择连接与仓储实现（唯一分叉点）──
var (
    userRepo domain.UserRepo
    mapRepo  domain.MapRepo
    tx       domain.TxManager
    closers  []func()
)
switch cfg.DB.Driver {
case "sqlite":
    db := sqlitedb.Open(cfg.DB.SQLitePath)      // 内含 PRAGMA 与 MaxOpenConns(1)
    migrate.Run(db, migrations.SQLiteFS)        // 跑 sqlite 迁移集
    q := sqliterepo.New(db)
    userRepo, mapRepo = sqliterepo.NewUserRepo(q), sqliterepo.NewMapRepo(q)
    tx = sqliterepo.NewTxManager(db)
    closers = append(closers, db.Close)
case "postgres":
    pool := pgdb.Connect(cfg.DB.URL)            // pgxpool
    migrate.Run(pool, migrations.PostgresFS)    // 跑 postgres 迁移集
    q := pgrepo.New(pool)
    userRepo, mapRepo = pgrepo.NewUserRepo(q), pgrepo.NewMapRepo(q)
    tx = pgrepo.NewTxManager(pool)
    closers = append(closers, pool.Close)
default:
    log.Error("unknown WMIND_DB_DRIVER", "driver", cfg.DB.Driver); os.Exit(1)
}

// ── 以下与方言无关，两种驱动完全相同 ──
store    := storage.NewLocal(cfg.Storage)
authSvc  := service.NewAuthService(userRepo, tokenRepo, tx, cfg.Auth)
mapSvc   := service.NewMapService(mapRepo, settingSvc, store, tx)
router   := httpapi.NewRouter(httpapi.Deps{Auth: authSvc, Map: mapSvc, ...})
```

**这个 `switch` 是全局唯一需要感知数据库方言的地方**。service 与 handler 层完全不知道底层是哪种数据库——这是「双方言不泄漏」的验收标准。

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
| `POST /maps/{uid}/shares` | 用户 | 30 次 / 分钟 |
| `GET /public/shares/{token}` | IP + token | 60 次 / 分钟 |
| `POST /public/shares/{token}/verify` | IP + token | 10 次 / 分钟（防密码暴力破解） |
| `POST /admin/users/{uid}/reset-password` | 管理员 | 20 次 / 小时 |
| `POST /export` | 用户 | 10 次 / 分钟 |
| `POST /files` | 用户 | 20 次 / 分钟 |
| 其他已登录接口 | 用户 | 300 次 / 分钟 |
| 公开只读接口 | IP | 120 次 / 分钟 |

> **二期补入的限流行**（一期不注册这些路由，故不生效）：`POST /auth/forgot-password`（IP + 邮箱，3 次/小时，防枚举）、`POST /auth/reset-password`（IP，10 次/小时）、`POST /auth/resend-verification`（用户，3 次/小时）、`POST /admin/mail/test`（管理员，5 次/分钟）。

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
    "passwordMinLength": 8,
    "importEnabled": true,
    "exportEnabled": true,
    "userTemplateEnabled": true,
    "shareEnabled": true,
    "shareDefaultExpireDays": 0,
    "shareDefaultAllowDownload": true,
    "version": "1.0.0"
  }
}
```

`shareEnabled` 由 `share.public_link_enabled` 派生，用于在前端隐藏「创建分享链接」入口（对应 `SHARE_DISABLED`）。字段清单由 `internal/handler/site.go` 的 `siteConfig` 结构体白名单决定：**新增设置项不会自动暴露**，必须同时改那里，否则敏感设置会被公开接口带出去。

`shareDefaultExpireDays` / `shareDefaultAllowDownload` 只是**表单预填值**，让后台里那两项设置改了能落到界面上。真正有约束力的两项（`share.require_password`、`share.max_links_per_map`）刻意不公开：它们是服务端强制的策略，前端知道与否都改变不了结果，公开只会让「为什么我填了却被拒」多一条可被探测的信息。

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

> **一期注册即生效**：不接入 SMTP，因此注册成功后用户 `status` 直接为 `active`，无需任何邮件确认。二期若启用邮箱验证（`auth.email_verification_required = true`），用户将以 `status = pending` 创建、不下发令牌，响应体追加 `requiresEmailVerification: true` 与 `emailSent` 字段，登录时返回 `AUTH_ACCOUNT_PENDING`。归档设计见 [09-技术决策记录](./09-技术决策记录.md) ADR-012。

#### `POST /api/v1/auth/login`

```json
// 请求
{ "identifier": "alice@example.com", "password": "********" }
```

`identifier` 同时接受邮箱与用户名。失败统一返回 `AUTH_INVALID_CREDENTIALS`（401），不区分「用户不存在」与「密码错误」。账号被禁用返回 `AUTH_ACCOUNT_DISABLED`（403）。

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

#### 一期不提供的接口（二期归档）

以下四个接口一期**不注册路由**（调用返回 404），设计保留在 [09-技术决策记录](./09-技术决策记录.md) ADR-012，二期直接落地：

| 接口 | 说明 | 关键约束（二期） |
| --- | --- | --- |
| `POST /auth/forgot-password` | 请求密码重置邮件 | 无论邮箱是否存在响应完全一致（防枚举）；限流 3 次/小时（IP + 邮箱）；`mail.enabled = false` 时返回 `MAIL_NOT_CONFIGURED`（503） |
| `POST /auth/reset-password` | 用令牌设置新密码 | 校验令牌存在/未使用/未过期；成功后写 `used_at`、更新密码哈希、**撤销该用户全部 refresh token**；失败统一返回 `AUTH_TOKEN_INVALID`（401） |
| `POST /auth/verify-email` | 邮箱验证 | 校验 `email_verify` 令牌，写 `users.email_verified_at`，`status` 由 `pending` 改为 `active` |
| `POST /auth/resend-verification` | 重发验证邮件 | 重新签发令牌并作废旧令牌；限流 3 次/小时 |

> **一期账号找回的替代闭环**：管理员在后台执行 `POST /admin/users/{uid}/reset-password`（见 §5.9），一次性展示新密码，用户用新密码登录。登录页需给出「忘记密码请联系管理员」的引导文案。

### 5.3 导图接口

#### `GET /api/v1/maps`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `page` | int | 默认 1 |
| `page_size` | int | 默认 20，最大 100 |
| `q` | string | 标题模糊搜索 |
| `sort` | string | `updated`（默认）\| `created` \| `title`。未知值回落到默认 |
| `updated_since` | string | RFC 3339。**客户端增量同步预留**，返回该时间后更新的导图（含已删除标记） |

> **`sort` 与初版设计的差异**：初版写的是 `-updated_at` / `-created_at`（JSON:API
> 风格的方向前缀 + 列名）。实现时改成 `updated` / `created` / `title` 三个语义名，
> 理由是这里没有升序变体，方向前缀没有信息量，而把列名暴露给前端会让「以后改
> 索引名」变成一次接口变更。
>
> 排序不是参数化 ORDER BY：sqlc 的 SQLite 引擎不重写 ORDER BY 表达式里的命名
> 参数（生成的 SQL 里会留着字面量 `sqlc.arg(sort)`），而 `ORDER BY CASE` 还会让
> 索引全部失效。实际实现是**每个顺序一条固定查询**，由 `domain.MapSort` 枚举
> 挑选。附带收益：三条查询都以 `id DESC` 收尾，保证 `updated_at` 毫秒并列时
> 分页不会重复或跳行。

```json
{
  "data": [
    {
      "uid": "01JFA8...",
      "title": "产品规划",
      "thumbnailUrl": "/uploads/file_9f3c....png",
      "nodeCount": 42,
      "sizeBytes": 18342,
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
>
> `thumbnailUrl` 为空串表示这张图还没有缩略图（前端显示占位图标）。

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

```json
{ "thumbnailUrl": "/uploads/file_9f3c....png" }
```

返回 `204`。空串表示清除缩略图。

> **与初版设计的差异**：初版是 `multipart/form-data` 直接传图片（一张请求搞定）。
> 实现改成「先 `POST /files` 传图、再把返回的 URL 写回来」，理由是复用已有的
> 上传与静态目录两条通路，不必为缩略图再写一遍解码、校验、存储、回放。
>
> 代价有两个，都记在这里：多一次往返（缩略图是后台生成的一次性动作，无所谓），
> 以及彻底删除导图时**不会**连带删掉 `/uploads` 下的缩略图文件——`files` 表
> 目前没有删除通路，这是既有缺口，不是缩略图引入的。
>
> 只接受**站内相对路径**（以单个 `/` 开头且不是 `//`）。这个字段会被所有列表页
> 渲染进 `<img src>`，让它只能指向本站是成本最低的一条防线。
>
> 缩略图**不在保存接口里**：`PUT /maps/{uid}` 不碰 `thumbnail_url`。合在一起的话，
> 自动保存（手里没有缩略图）每次都会把它擦成空串。

#### `GET /api/v1/trash`

回收站列表，参数同 `GET /maps`。

#### `POST /api/v1/trash/{uid}/restore`

恢复导图。若同名冲突不处理（标题可重复）。

#### `DELETE /api/v1/trash/{uid}`

彻底删除（连带删除缩略图文件），返回 `204`。

#### `DELETE /api/v1/trash`

清空回收站。

### 5.4 模板接口

**内置的 8 个模板不经过这里**：它们编译进前端包
（`frontend/src/features/templates/builtin.ts`）。三条理由：

1. 选择对话框要渲染**实时预览**，预览需要文档，所以文档必须在请求回来之前就存在；
2. 模板名是 i18n 键，一个 TEXT 列存不下一份在 zh-CN 与 en-US 里都成立的文案；
3. 骨架由 `createDocument` / `createTopic` 构造，文档模型新增必填字段时自动跟上，
   而不是在仓库里躺一份会静默失效的 JSON。

这与 10 套内置配色走前端静态资源是同一个决定（见 §5.5 与 ADR-019）。
`templates` 表的 `is_builtin` 与可空 `owner_id` 保留为二期「管理员维护内置模板」
的钩子。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/templates` | 当前用户的模板列表。**不含 `document`** |
| `GET` | `/api/v1/templates/{uid}` | 单条读取，**含 `document`**（用它建图时调一次） |
| `POST` | `/api/v1/templates` | 从导图创建用户模板：`{ "name": "...", "mapUid": "..." }` |
| `PATCH` | `/api/v1/templates/{uid}` | 重命名：`{ "name": "..." }` |
| `DELETE` | `/api/v1/templates/{uid}` | 删除用户模板；内置模板返回 `TEMPLATE_BUILTIN_READONLY` |

```json
// GET /api/v1/templates 的一项
{
  "uid": "01JFB2M4K6P8R1T3V5W7X9Y0Z2",
  "name": "我的起点",
  "category": "user",
  "structure": "org-chart",
  "thumbnailUrl": "/uploads/01JFA8.png",
  "isBuiltin": false,
  "createdAt": "2026-10-21T02:30:00Z",
  "updatedAt": "2026-10-21T02:30:00Z"
}
```

**为什么列表不带 `document`**：一份模板文档的上限与导图一样是 8 MiB，50 个模板
就是 400 MB 的列表响应。列表只需要名字、结构、缩略图；真要用某个模板建图时，
`GET /templates/{uid}` 单独取一次。

**其余约束**：

- `name` 去空白后 1~64 字符。
- `category` 服务端恒写 `user`；`is_builtin` 恒写 `false`；`sort_order` 恒写 `0`
  ——由请求决定这三个字段会让调用方伪造出「改不掉的内置模板」，或把自己挤到别人
  列表的顶部。
- `thumbnail_url` 由服务端从**源导图**复制，不接受请求传入：否则模板列表会变成
  一个加载任意地址的图片代理。
- `structure` 从源文档的 `sheets[0].structure` 读出；缺失或空白兜底成 `mindmap`。
- `feature.user_template_enabled = false` → 403 `TEMPLATE_DISABLED`（五个接口全部）。
  内置模板不受影响。
- 每个用户上限 50 条 → 403 `TEMPLATE_LIMIT_REACHED`。
- 文档原样复制，模板与源导图从此解耦（FR-TPL-06）：改导图不影响模板，改模板不影响
  已经建出来的导图。

### 5.5 主题接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/themes` | 返回**当前用户的自定义主题**（不分页，上限 50 条） |
| `POST` | `/api/v1/themes` | 创建自定义主题：`{ "name": "...", "config": { /* Theme */ } }` |
| `PUT` | `/api/v1/themes/{uid}` | 更新自定义主题（名字 + 配置全量覆盖） |
| `DELETE` | `/api/v1/themes/{uid}` | 删除；内置主题返回 `THEME_BUILTIN_READONLY` |

**内置的 10 套配色不走这个接口**（M3.5 的收敛，见 ADR-019）：

- 它们是前端包内的静态资源 `frontend/src/editor/theme/palettes.json`。编辑器首帧就要
  用 `resolveStyle` 算出每个节点的填充与字色，不能等一个请求回来——否则打开导图
  会先白一帧再上色，离线打开则完全不可用。
- 若同时往 `themes` 表里种一份，就出现两份「事实来源」：改配色要改两处，还要再
  写一道一致性闸门；而服务端那份的 `config` 还得用 Go 重新装配 `themeFromPalette`
  的逻辑，那是把前端样式体系抄一遍。

因此 `themes` 表只放用户主题，`owner_id` 恒非空、`is_builtin` 恒为 false；两个字段
保留是给二期「管理员维护内置主题」留的口子。响应里的 `config` 会被服务端规范化：
`id` 改写成该主题的 `uid`、`name` 改写成主题名、`category` 改写为 `custom`——客户端
发上来的通常是「当前画布的主题」，它的 `id` 很可能还是某个内置配色的 id。

**校验**：`name` 去空白后 1~64 字符；`config` 必须是 JSON 对象、≤ 64 KiB、含非空
`palette.colors`、所有颜色为 `#RRGGBB`、含非空 `global.fontFamily` 且 `fontSize > 0`。
未知字段原样保留（前端给 `Theme` 加字段不该被服务端吃掉）。

### 5.6 文件接口

#### `POST /api/v1/files`

上传一张图片。`multipart/form-data`，字段 `file`。需要登录态。

| 约束 | 值 | 说明 |
| --- | --- | --- |
| 单文件字节数 | 8 MB | 超限 `413 FILE_TOO_LARGE` |
| 像素总数 | 4000 万 | 超限同样 `FILE_TOO_LARGE`（`details.maxPixels`） |
| 允许的格式 | PNG / JPEG / GIF / WebP | 其余 `415 FILE_TYPE_NOT_ALLOWED` |
| 限流 | 120 次/分钟/用户 | 按 `user_uid` 而不是 IP |

```json
{
  "data": {
    "uid": "9736debf25f08efe5fd0dd392d788a5b",
    "url": "/uploads/file_9736debf25f08efe5fd0dd392d788a5b.png",
    "width": 40,
    "height": 30,
    "format": "png",
    "bytes": 98
  }
}
```

四条实现约定：

1. **类型由解码结果决定**，不看 `Content-Type`，也不看扩展名。存下来的扩展名来自解码出的格式——一个叫 `photo.png` 的 JPEG 会存成 `.jpg`，避免浏览器按扩展名猜错。
2. **同时卡字节与像素**。只看字节挡不住「纯色 10000×10000 PNG」：它压完只有几十 KB，解开却是几百 MB 的位图。用 `image.DecodeConfig` 只读文件头，不解整张图，内存因此是平的。
3. **文件名与 URL 由服务端生成**（`file_<128 位随机 hex><ext>`）。文件名是凭据，不能用 ULID——ULID 前 48 位是时间戳，等于把「什么时候传的」和可枚举性一起送出去。
4. **没有 `kind` 参数**。这个接口目前只服务「导入时还原图片」，而导入的调用方自己知道传的是什么；加一个只用来做白名单分支的参数，等真有第二种用途时再加不迟。

#### 读取：`GET /uploads/{name}`

文件**不在 `/api/v1` 下**，由 Go 进程在根路径 `/uploads` 直接回放静态目录（与头像同一条映射，见 `router.go` 的 `r.Static`），生产环境由 Nginx 直接命中磁盘。

因此**没有鉴权**：URL 里的 128 位随机串就是凭据。这个取舍与头像一致——图片要嵌在 `<img>` 里、要能进导出产物，加一层令牌只会让渲染链路多一次失败点；而猜中 32 个 hex 字符的概率可以忽略。

#### `DELETE /api/v1/files/{uid}`（未实现，随 M5 落地）

单文件删除的问题不是权限，而是**引用计数**：一张图片可能被同一份导图的多个节点引用，也可能被复制到别的导图里。现在删掉它，别处的图就静默变成破图。正确做法是随导图清理任务一起做（`docs/07` 的孤儿文件回收），而不是开一个能被界面随手调用的删除接口。

### 5.7 分享接口

#### `POST /api/v1/maps/{uid}/shares`

创建分享链接。需登录且为导图属主。

```json
// 请求
{
  "password": "optional-pass",   // 省略或空串 = 无密码
  "expiresInDays": 7,            // 0 或省略 = 永久
  "allowDownload": true,
  "showNotes": true
}
```

```json
// 201
{
  "data": {
    "uid": "01JFB2M4K6P8R1T3V5W7X9Y0Z2",
    "token": "kJ8xQ2mNp4Vt7Zs1Rw9YbC",
    "url": "https://wmind.example.com/s/kJ8xQ2mNp4Vt7Zs1Rw9YbC",
    "hasPassword": true,
    "allowDownload": true,
    "showNotes": true,
    "expiresAt": "2026-10-23T02:30:00Z",
    "viewCount": 0,
    "createdAt": "2026-10-16T02:30:00Z"
  }
}
```

- `token` 明文返回（属主可随时复制），`url` 由 `site.base_url` 拼接。
- `site.base_url` **为空时 `url` 是相对路径**（`/s/<token>`），前端用 `window.location.origin` 补全。这是刻意的：反代后面的服务端看到的 `Host` 往往不是用户实际访问的域名（内网地址、容器名、端口都不对），在服务端猜绝对地址比让浏览器补更错。
- `share.public_link_enabled = false` → 403 `SHARE_DISABLED`。
- `share.require_password = true` 且未提供密码 → 422 `VALIDATION_FAILED`。
- 超过 `share.max_links_per_map` → 403 `SHARE_LIMIT_REACHED`。计数只算**未撤销**的链接：撤销后的链接已经打不开，再占配额只会逼用户删记录、连带丢掉访问统计。
- 创建与撤销均写入 `audit_logs`（`share.create` / `share.revoke`，`detail` 里带 `mapUid`）。

#### `GET /api/v1/maps/{uid}/shares`

某张导图的分享链接列表（仅属主）。返回数组，字段同创建响应的 `data`。

#### `GET /api/v1/shares`

「我的分享」列表：当前用户创建的全部分享链接，支持 `map_uid` 过滤与分页。

#### `PATCH /api/v1/shares/{uid}`

```json
{
  "password": "new-pass",        // 传 null 表示清除密码
  "expiresInDays": 30,
  "allowDownload": false,
  "showNotes": true
}
```

仅修改显式传入的字段。改密码不影响已发放的访问凭证（需撤销并重建才能立即失效）。

`password` 的三种取值必须区分：**字段缺省** = 不改；**`null`** = 清除密码；**字符串** = 设为该密码。所以 handler 用 `json.RawMessage` 解析这一个字段，而不是 `*string`——后者会把「缺省」和 `null` 都折叠成 `nil`，于是「只想关掉下载」会顺手把密码抹掉。

已撤销的链接不可再修改（404 `SHARE_NOT_FOUND`）：撤销是终态，允许修改等于允许复活一条已经发出去、对方可能已经收到「已失效」的链接。

#### `DELETE /api/v1/shares/{uid}`

撤销分享（写入 `revoked_at`），返回 `204`。撤销后该链接立即失效，**不物理删除**记录以便保留访问统计。

#### `GET /api/v1/public/shares/{token}`

**公开接口，无需登录。** 返回渲染所需的完整数据。

```json
// 200（无密码，或已通过 verify 并携带 X-Share-Access 头）
{
  "data": {
    "title": "产品规划",
    "document": { "...": "完整的 .wmind 文档" },
    "allowDownload": true,
    "showNotes": true,
    "siteName": "wmind",
    "logoUrl": "",
    "ownerNickname": "Alice",
    "createdAt": "2026-10-16T02:30:00Z",
    "expiresAt": null
  }
}
```

```json
// 401 —— 需要密码且未验证
{ "error": { "code": "SHARE_PASSWORD_REQUIRED", "message": "该分享需要访问密码" } }
```

**服务端必须做的处理**：

| 处理 | 说明 |
| --- | --- |
| 剥离备注 | `showNotes = false` 时，服务端**在返回前**删除文档中所有 `notes` 字段，而不是靠前端隐藏 |
| 剥离内部字段 | 删除 `extensions`、`meta.app` 等与渲染无关的字段 |
| 不含属主信息 | 不返回 `owner.uid` / 邮箱，只返回昵称 |
| 失效统一处理 | 令牌不存在、已撤销、已过期、导图已删除，全部返回 404 `SHARE_NOT_FOUND`，**不区分原因** |
| 访问计数 | 去重窗口 30 分钟（键 = token + IP 哈希），命中窗口外才 `view_count + 1`。单实例内存实现，多实例换 Redis |

> **`allowDownload = false` 的能力边界**：分享页需要支持折叠、缩放等交互，因此必须把文档结构下发给浏览器。这意味着**有技术能力的访问者仍可通过开发者工具获取数据**。`allowDownload = false` 只能做到「隐藏导出入口 + 拒绝服务端导出接口」，属于**降低门槛而非访问控制**。若需要真正的访问控制，应使用密码保护，或二期引入「只下发预渲染 SVG、不支持交互」的严格模式。

#### `POST /api/v1/public/shares/{token}/verify`

```json
// 请求
{ "password": "xxx" }
```

```json
// 200
{ "data": { "accessToken": "eyJhbGci...", "expiresIn": 1800 } }
```

- 返回的 `accessToken` 为 `typ: share` 的短期 JWT（30 分钟），前端存 `sessionStorage`，后续请求带 `X-Share-Access: <token>` 头。
- 密码错误返回 401 `SHARE_PASSWORD_INVALID`；限流 10 次/分钟防暴力破解。
- 未设密码的分享调用本接口返回 422 `VALIDATION_FAILED`。

### 5.8 服务端导出接口（大图兜底）

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

### 5.9 管理接口

全部要求 `role = admin`。

#### `GET /api/v1/admin/users`

| 参数 | 说明 |
| --- | --- |
| `page` / `page_size` | 分页 |
| `q` | 匹配用户名 / 邮箱 / 昵称 |
| `role` | `user` \| `admin` |
| `status` | `active` \| `disabled` |
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

**一期账号找回的唯一入口**（不接入 SMTP）。

```json
// 请求
{ "password": "********" }   // 省略或为空则服务端随机生成强密码
```

```json
// 200 —— 新密码仅在此响应中出现一次
{ "data": { "password": "Xk7#mQ2pLw9z", "generated": true } }
```

- 响应中的新密码**仅此一次**返回，服务端不保存明文、不写日志、不可再次查询。
- 成功后**撤销该用户全部 refresh token**（含当前在线设备），并失效其状态缓存。
- 不可重置自己的密码（改自己密码走 `POST /users/me/password`），返回 `ADMIN_CANNOT_RESET_SELF`（409），避免误操作锁死自身。
- 写入审计日志：`action = user.reset_password`，记录操作人、目标用户、时间、IP，**不记录密码**（detail 为 `{generated, username}`）。

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

部分更新；未知 key 或类型不匹配返回 `SETTINGS_INVALID`（422），`error.details.fields` 以**设置键**为键指出哪一项错了。

校验是「全通过才写」：同一请求里只要有一项非法，其余合法项也不会落库——否则「关掉注册成功、改密码长度失败」会让管理员误以为两件事都失败。

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

参数：`page`、`page_size`、`action`、`actor_uid`、`from`、`to`（RFC3339 或 `yyyy-mm-dd`）。

动作名集中定义在 `internal/domain/audit.go`，避免各处手写字符串导致统计口径分裂：

| action | 触发时机 | detail |
| --- | --- | --- |
| `user.create` | 管理员创建用户 | `{username, email, role}` |
| `user.update` | 改昵称/邮箱 | `{changes}` |
| `user.role` | 改角色 | `{from, to}` |
| `user.disable` / `user.enable` | 禁用 / 启用 | `{from, to}` |
| `user.delete` | 删除用户 | `{username, email}` |
| `user.reset_password` | 重置密码 | `{generated, username}`，**不含密码** |
| `settings.update` | 改站点设置 | `{keys: [...]}`，只记键名不记值 |

> 审计写入失败只打 ERROR 日志，不让管理操作失败：操作已经生效，返回 500 会诱导重试，而重试会重复副作用（重置密码尤其糟糕）。取舍是「可用性优先于完整性」，极端情况下会丢记录。

> **二期归档接口**：`POST /admin/mail/test`（发送测试邮件，支持传入未保存的 `config` 以便「先测再存」，失败返回 `MAIL_SEND_FAILED` 并带 `details.stage = connect | tls | auth | send`）一期不注册，设计见 [09-技术决策记录](./09-技术决策记录.md) ADR-012。

### 5.10 接口汇总

| 分组 | 数量 | 说明 |
| --- | --- | --- |
| 公开 | 3 | `health/live`、`health/ready`、`site/config` |
| 认证与个人 | 8 | register / login / refresh / logout / me / `PATCH users/me` / password / avatar |
| 导图 | 12 | 列表、创建、读取、保存、重命名、删除、复制、缩略图、回收站 ×4 |
| 模板 | 5 | 列表、单条（含 `document`）、创建（从导图另存为）、改名、删除 |
| 主题 | 4 | 列表、创建、更新、删除 |
| 文件 | 1 | 上传（读取走 `/uploads` 静态目录；**没有删除接口**，`DELETE files/{uid}` 已从一期移除） |
| **分享** | **7** | 登录态 5（创建、导图维度列表、我的分享、修改、撤销）+ 公开 2（读取、密码校验） |
| 导出 | 0（设计 1） | `GET /maps/{uid}/export` 设计已定但**尚未注册**，现在访问返回 404（M6 落地） |
| 管理 | 9 | 用户 ×5（含重置密码）、设置 ×2、统计、审计日志 |
| **合计** | **49** | 逐条核对 `router.go` 的实际注册数 |

> 合计按**已注册**的路由数统计，不按设计条目数：导出那条只有设计、没有路由，算进去会变成 50。相比 v1.1 的 55 个减少 6 个——移除 7 个（`forgot-password` / `reset-password` / `verify-email` / `resend-verification` / `admin/mail/test` / `GET files/{uid}` / `DELETE files/{uid}`），分享的「公开读取」与「密码校验」由一条拆成两条（+1）。
>
> 二期接入邮件后，注册数与设计条目数同步回到 55。`POST /admin/users/{uid}/reset-password` 一期即为正式接口（非占位），二期也不会移除——它与邮件重置是并存的两条找回路径。

---

## 6. 错误码表

| HTTP | code | 说明 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 请求体格式错误 |
| 401 | `AUTH_INVALID_CREDENTIALS` | 账号或密码错误 |
| 401 | `AUTH_TOKEN_EXPIRED` | Access Token 过期（前端应触发刷新） |
| 401 | `AUTH_TOKEN_INVALID` | 令牌无效或签名错误 |
| 401 | `AUTH_REFRESH_INVALID` | Refresh Token 无效或已撤销 |
| 401 | `SHARE_PASSWORD_REQUIRED` | 该分享需要访问密码 |
| 401 | `SHARE_PASSWORD_INVALID` | 分享访问密码错误 |
| 403 | `AUTH_ACCOUNT_DISABLED` | 账号已被禁用 |
| 403 | `AUTH_FORBIDDEN` | 无权限访问该接口 |
| 403 | `REGISTRATION_CLOSED` | 站点已关闭注册 |
| 403 | `MAP_LIMIT_REACHED` | 已达单用户导图数量上限 |
| 403 | `SHARE_DISABLED` | 站点已关闭分享功能 |
| 403 | `SHARE_LIMIT_REACHED` | 单张导图的分享链接数量已达上限 |
| 403 | `TEMPLATE_BUILTIN_READONLY` | 内置模板不可修改 |
| 403 | `TEMPLATE_DISABLED` | 站点已关闭用户模板（`feature.user_template_enabled = false`） |
| 403 | `TEMPLATE_LIMIT_REACHED` | 用户模板数量已达上限（50） |
| 403 | `THEME_BUILTIN_READONLY` | 内置主题不可修改 |
| 403 | `THEME_LIMIT_REACHED` | 自定义主题数量已达上限（50） |
| 403 | `EXPORT_DISABLED` | 站点已关闭导出 |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在 |
| 404 | `MAP_NOT_FOUND` | 导图不存在或无权访问 |
| 404 | `SHARE_NOT_FOUND` | 分享不存在、已撤销、已过期或导图已删除（**不区分原因**） |
| 404 | `TEMPLATE_NOT_FOUND` | 模板不存在 |
| 404 | `THEME_NOT_FOUND` | 主题不存在 |
| 404 | `FILE_NOT_FOUND` | 文件不存在 |
| 409 | `AUTH_EMAIL_TAKEN` | 邮箱已被占用 |
| 409 | `AUTH_USERNAME_TAKEN` | 用户名已被占用 |
| 409 | `MAP_VERSION_CONFLICT` | 导图版本冲突（并发保存） |
| 409 | `ADMIN_LAST_ADMIN` | 不能降级或删除最后一个管理员 |
| 409 | `ADMIN_CANNOT_DELETE_SELF` | 不能删除自己 |
| 409 | `ADMIN_CANNOT_RESET_SELF` | 管理员不能通过后台重置自己的密码 |
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

> **二期邮件相关错误码**（一期不返回，编码已预留以避免二期重编号）：`403 AUTH_ACCOUNT_PENDING`（账号待激活，邮箱未验证）、`502 MAIL_SEND_FAILED`（`details.stage` 指明 `connect`/`tls`/`auth`/`send`）、`503 MAIL_NOT_CONFIGURED`（邮件服务未启用或未配置）、`503 ENCRYPTION_KEY_MISSING`（未配置加密密钥，无法保存敏感配置）。

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

> **SQLite 侧无 `FOR UPDATE`**：该方言不支持行级锁。SQLite 版的保存事务改为 `BEGIN IMMEDIATE`（事务开始即获取写锁）+ `MaxOpenConns(1)`（全局单写者），此时「同事务内竞态」在物理上不可能发生，`version` 乐观锁依然保留用于跨请求冲突检测。语义等价，写法不同——这是 §7.9.3 差异清单中的一项。

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

### 7.6 邮件服务（二期归档）

**一期不实现**：不引入 `mail` 模块、不注册相关路由、不读取任何 `mail.*` 设置。因此一期也**没有**「邮件发送失败不阻断主流程」这类问题——不存在邮件调用。

二期落地时按下述已定方案实现（完整理由与被否方案见 [09-技术决策记录](./09-技术决策记录.md) ADR-012）：

选型：`github.com/wneessen/go-mail`（活跃维护、API 清晰、原生支持 STARTTLS / 隐式 TLS / 连接池）。

```go
type MailService interface {
    Enabled() bool
    Send(ctx context.Context, msg MailMessage) error
    TestConfig(ctx context.Context, cfg MailConfig, to string) error
}

type MailMessage struct {
    To      string
    Subject string
    HTML    string
    Text    string   // 纯文本降级
}
```

**关键实现约束**（二期）：

| 约束 | 说明 |
| --- | --- |
| 异步发送 | 注册、忘记密码等接口**不阻塞**在 SMTP 往返上。邮件发送走一个容量 256 的带缓冲 channel + 2 个 worker goroutine；队列满时降级为同步发送并记录 `WARN` |
| 发送失败不阻断主流程 | 注册成功但邮件发送失败时，用户仍然创建成功，接口返回 `emailSent: false` 并提示可重发 |
| 超时 | 单封邮件 10 秒超时（含连接、TLS、认证、发送） |
| 重试 | 仅对「连接失败」重试 1 次（间隔 2 秒）；认证失败不重试（配置错误，重试无意义） |
| 密码解密 | 从 `settings` 读取 `mail.password` 时先解密；解密失败则视为未配置并记录 `ERROR` |
| 并发安全 | 配置变更时重建客户端，用 `atomic.Pointer` 持有，避免发送中配置被改 |
| 不记录正文 | 日志中只记收件人、模板名、结果，不记邮件正文与令牌 |

**邮件模板**（二期）：内置 3 个模板（`verify_email`、`reset_password`、`test`），使用 Go `html/template`，嵌入二进制。模板变量：`SiteName`、`SiteLogo`、`SiteICP`、`Nickname`、`ActionURL`、`ExpireMinutes`。所有变量在渲染时自动转义。

### 7.7 分享链接服务

```go
func (s *ShareService) Resolve(ctx context.Context, token string, accessToken string) (*ShareView, error)
```

解析顺序与判定：

```
1. 查 share_links WHERE token = ?  → 未命中 ⇒ SHARE_NOT_FOUND (404)
2. revoked_at 非空                    ⇒ SHARE_NOT_FOUND (404)
3. expires_at 非空且已过期            ⇒ SHARE_NOT_FOUND (404)
4. 关联的 maps.deleted_at 非空        ⇒ SHARE_NOT_FOUND (404)
5. 站点 share.public_link_enabled=false ⇒ SHARE_DISABLED (403)
6. password_hash 非空：
     ├─ 无 X-Share-Access 头              ⇒ SHARE_PASSWORD_REQUIRED (401)
     └─ 校验 accessToken（typ=share，
        且 sub = share.uid）失败         ⇒ SHARE_PASSWORD_REQUIRED (401)
7. 通过 ⇒ 构造响应
```

**令牌生成**：

```go
func newShareToken() string {
    b := make([]byte, 16)                 // 128 bit
    rand.Read(b)
    return base64.RawURLEncoding.EncodeToString(b)   // 22 字符，URL 安全
}
```

**响应构造时按 `show_notes` 剥离备注**：

```go
if !share.ShowNotes {
    docmodel.WalkAll(doc, func(t *docmodel.Topic) { t.Notes = docmodel.Notes{} })
}
```

**`X-Share-Access` 令牌**：`typ: share`、`sub: share.uid`、`exp: 30min`、HS256。用 `sub` 绑定到具体分享记录，防止把一个分享的访问令牌用到另一个分享上。

#### 与初版设计的差异（实现时定稿）

1. **`iss` 不同**。分享访问令牌用 `wmind-share`，登录令牌用 `wmind`。两者同一个密钥签发，如果 `iss` 也相同，分享令牌在结构上就是一枚合法的访问令牌，`typ` 只是第二道锁。改 `iss` 让两种令牌在 jwt 库的校验层就互相拒绝。

2. **剥离备注不用 `WalkAll`，改成 JSON 往返**。`service/share_document.go` 把文档解成 `map[string]any`，递归删除 `notes`（仅在 `showNotes = false` 时）与 `extensions`，再序列化回去。理由是 `WalkAll` 依赖文档模型的结构体标签，而这个响应是**公开**的——模型里将来新增一个字段（比如协同编辑的内部 id），只要没人记得在剥离函数里补一行，它就自动出现在公开响应里。JSON 往返是白名单的反面：默认全部透传，只删明确要删的。解码必须 `dec.UseNumber()`，否则 `float64` 会把 `16777217` 变成 `16777216`，某些宽度会静默少 1px。

3. **访问计数带 30 分钟去重窗口**（键 = token + IP 的 SHA-256）。同一访客刷新十次不该算十次访问。IP 进哈希而不是明文存表：`share_links` 的访问记录可能被导出做排查，「哪个 IP 看了哪张图」属于访问数据，不该在表里躺着。

4. **`UpdateShare` 是整行写入，不是局部 patch**。sqlc 的 SQLite 引擎不会重写 `CASE WHEN narg(...)` 里的命名参数，所以「只更新传入的列」这条 SQL 写不出来。service 做读-合并-写。代价是并发 PATCH 为 last-write-wins，可以接受：这几个字段是同一人在同一个对话框里翻的独立开关。

5. **`share.default_expire_days` / `share.default_allow_download` 走站点公开配置**（见 §5.1），不进服务端策略。

### 7.8 优雅退出

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

### 7.9 双方言仓储层

一期同时支持 PostgreSQL 与 SQLite（见 [09](./09-技术决策记录.md) ADR-015）。这一节是双方言在**后端代码层面**的全部落点——除此之外的任何地方都不应该出现方言判断。

#### 7.9.1 sqlc 双 target

`backend/db/sqlc.yaml` 配两个 target，生成两个互不相干的包：

```yaml
version: "2"
sql:
  - engine: "postgresql"
    schema:  "migrations/postgres"
    queries: ["queries/shared", "queries/postgres"]
    gen:
      go:
        package: "pgdb"
        out:     "../internal/repository/postgres/pgdb"
        sql_package: "pgx/v5"
        emit_pointers_for_null_types: true
  - engine: "sqlite"
    schema:  "migrations/sqlite"
    queries: ["queries/shared", "queries/sqlite"]
    gen:
      go:
        package: "sqlitedb"
        out:     "../internal/repository/sqlite/sqlitedb"
        sql_package: "database/sql"
        emit_pointers_for_null_types: true
```

关键点：

- **`queries/shared` 被两个 target 同时读取**。命名参数必须写为 `sqlc.arg(name)`，绝不手写 `$1` 或 `?`；sqlc 会分别生成 PostgreSQL `$1` 与 SQLite `?1`。
- **shared 与方言 SQL 源文件必须保持 ASCII-only**（含注释和字符串字面量）。sqlc v1.31.1 的 SQLite 参数重写对非 ASCII 查询文本字节偏移不安全，会破坏查询文本。自然语言说明写在本节或 Agent Note，不写入这些 SQL 源。
- LIMIT/OFFSET 命名参数使用 `page_size` / `row_offset`，不要用 PostgreSQL 保留字 `limit` / `offset` 作参数名。
- 两个 target 的**包名与输出目录必须不同**，否则生成的 `Queries` 类型会冲突。
- 驱动包名不同（`pgx/v5` vs `database/sql`），因此生成的方法签名略有差异——这正是需要用 `domain` 接口兜住的原因。
- 若某个查询无法在 `shared` 下同时通过两个 engine 的解析，就把它移到方言目录，**不要为了共享而牺牲可读性**。

#### 7.9.2 事务抽象：`TxManager` + ctx 传递

service 层需要开启事务，但事务句柄的类型是方言相关的（`pgx.Tx` vs `sql.Tx`）。解法是把事务句柄挂在 `ctx` 上，service 只面向一个方言无关的接口：

```go
// domain/tx.go —— 方言无关
type TxManager interface {
    WithTx(ctx context.Context, fn func(ctx context.Context) error) error
}
```

两个实现各自把事务句柄放进 `ctx`：

```go
// repository/postgres/tx.go
type txKey struct{}

func (m *pgTxManager) WithTx(ctx context.Context, fn func(context.Context) error) error {
    tx, err := m.pool.Begin(ctx)
    if err != nil { return err }
    defer func() { _ = tx.Rollback(ctx) }()          // 已提交时 Rollback 是 no-op
    if err := fn(context.WithValue(ctx, txKey{}, tx)); err != nil { return err }
    return tx.Commit(ctx)
}
```

仓储内部从 `ctx` 取事务句柄，取不到就用连接池（sqlc 为两种 engine 都生成 `DBTX` 接口，两者可直接互换）：

```go
func (r *mapRepo) dbtx(ctx context.Context) pgdb.DBTX {
    if tx, ok := ctx.Value(txKey{}).(pgx.Tx); ok { return tx }
    return r.pool
}
```

service 层因此**完全不知道方言**：

```go
func (s *MapService) Save(ctx context.Context, in SaveInput) (*Map, error) {
    var out *Map
    err := s.tx.WithTx(ctx, func(ctx context.Context) error {   // 两种驱动写法完全相同
        m, err := s.maps.GetForUpdate(ctx, in.UID, in.OwnerID)
        // ...
        out = m
        return nil
    })
    return out, err
}
```

**取舍**：ctx 携带事务是隐式依赖，需要纪律——仓储方法**必须**通过 `dbtx(ctx)` 取句柄，不能直接用 `r.pool`。作为补偿，这个模式让 service 层的事务代码在两种驱动下逐字相同，是双方言方案里性价比最高的一处抽象。

#### 7.9.3 方言差异落点清单

**只有以下几处允许出现方言分支**，其他任何地方出现 `if driver == ...` 都属于设计违规：

| # | 落点 | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| 1 | 连接与迁移装配 | `pgdb.Connect` + `migrations/postgres` | `sqlitedb.Open` + `migrations/sqlite` |
| 2 | 事务管理器 | `pgTxManager`（`pool.Begin`） | `sqlTxManager`（`BEGIN IMMEDIATE`） |
| 3 | 标题搜索 | `ILIKE` + `pg_trgm` 索引 | `LIKE` |
| 4 | 保存事务的行锁 | `GetForUpdate`（`FOR UPDATE`） | `Get`（无锁，靠 `BEGIN IMMEDIATE`） |
| 5 | 数据概览的按日聚合 | `date_trunc('day', ...)` | `strftime('%Y-%m-%d', ...)` |
| 6 | 启动自检 | `SELECT 1` | `PRAGMA quick_check` + `SELECT 1` |
| 7 | 备份命令（CLI，非请求路径） | `pg_dump` | `VACUUM INTO` |

除第 1~2 项外，其余各项都只影响**单个查询文件**，不影响调用方。

#### 7.9.4 迁移与一致性校验

- 迁移用 golang-migrate，两个驱动分别注册：`database/postgres` 与 `database/sqlite`（modernc 版）。迁移文件编译期内嵌（`embed.FS`），二进制自带，不需要外部文件。
- `WMIND_AUTO_MIGRATE=true` 时启动即迁移，两种驱动行为一致。
- **`verify-migration-parity` 是必跑的门禁**：起两个临时数据库、各跑一遍迁移、introspect 出「表 → 列（名+类型类别）→ 索引（名+唯一性）」集合，规范化后比对，不一致即 CI 失败。它拦住的是最容易发生也最难发现的错误——只改了一边的迁移。

#### 7.9.5 测试策略（双方言）

| 层级 | PostgreSQL | SQLite |
| --- | --- | --- |
| 单元测试 | 不涉及 | 不涉及 |
| 仓储集成测试 | `testcontainers-go` 起真实 PG，CI 中跑 | `t.TempDir()` 建临时库 + 真实迁移，**本地即可跑，无需 Docker** |
| 仓储契约测试 | **同一组契约测试跑两遍** | 同上 |
| 接口测试 | `httptest`，驱动无关 | 同上 |

**仓储契约测试**是双方言正确性的核心保障：把「同一组输入 → 期望的仓储输出」写成一份表驱动测试，用两个驱动各跑一次。任何方言行为偏差（时间精度、布尔映射、`LIKE` 大小写、`RETURNING` 语义）都会在这里暴露。

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
| 分享页只读接口 | `/public/shares/{token}` 为纯 token 鉴权，客户端可直接复用；密码验证返回的 `X-Share-Access` 令牌与平台无关 |

**二期需要新增**：`POST /auth/device`（设备注册）、`GET /sync/changes`（批量增量拉取）、`POST /sync/push`（批量上行变更）、WebSocket 通道（实时协作）、邮件深链（`ActionURL` 由 `site.base_url` 拼接，可指向客户端自定义协议如 `wmind://` 或 Universal Link）。

---

## 9. 测试策略

| 层级 | 范围 | 工具 |
| --- | --- | --- |
| 单元测试 | `docmodel` 校验与遍历、`convert/*` 各格式双向转换、`auth` 令牌与密码 | `testing` + `testify` |
| 集成测试（PostgreSQL） | repository 的 SQL、service 的事务与权限 | `testcontainers-go` 起真实 PostgreSQL（CI） |
| 集成测试（SQLite） | 同上，**同一组测试** | 临时文件库 + 真实迁移，本地无需 Docker |
| 仓储契约测试 | 同一份表驱动用例在两种驱动下各跑一遍 | `testing` + 双驱动参数化 |
| 迁移一致性 | 两套迁移集的表/列/索引集合比对 | `verify-migration-parity`（CI 门禁） |
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
8. **分享令牌枚举防护**：随机生成 1000 个不存在的 token 请求公开接口，全部返回 404 且响应时间无显著差异。
9. **分享失效路径**：撤销 / 过期 / 导图被删 / 站点关闭分享，四种情况均返回 404 `SHARE_NOT_FOUND`（站点关闭时返回 403 `SHARE_DISABLED`）。
10. **`showNotes = false` 时服务端剥离**：断言响应 JSON 中不含任何 `notes` 字段（用递归遍历检查，而非只看根节点）。
11. **密码暴力破解防护**：连续 11 次错误密码后第 11 次返回 429。
12. **管理员重置密码**：重置后新密码可登录、旧密码不可登录、该用户其他设备 refresh token 全部失效、响应中的密码不可再次查询；重置自己返回 409 `ADMIN_CANNOT_RESET_SELF`。
13. **一期无邮件依赖**：断言路由表中不存在 `forgot-password` / `reset-password` / `verify-email` / `resend-verification` / `admin/mail/test`，且 `settings` 中不存在任何 `mail.*` 键（防止残留代码路径）。
14. **注册即生效**：一期注册成功后 `status` 直接为 `active`，可立即登录，响应中不含 `requiresEmailVerification` 字段。
15. **二期归档用例**（待二期启用时启用）：忘记密码防枚举、令牌一次性、SMTP 失败不阻断、SMTP 密码加解密往返。
16. **双方言契约一致性**：同一组仓储契约用例（含时间读写往返、布尔映射、JSON 文档读写、`RETURNING` 取值、软删除过滤、唯一约束冲突）在 PostgreSQL 与 SQLite 下结果完全相同。重点覆盖时间列——断言写入再读出的 `time.Time` 与原值相等且时区为 UTC。
17. **迁移一致性**：`verify-migration-parity` 在两边迁移集上通过；人为删掉 SQLite 的一个索引后该检查失败（验证门禁本身有效）。
18. **SQLite 并发安全**：并发 50 个写请求（保存导图）不出现 `SQLITE_BUSY` / `database is locked`；`journal_mode` 确认为 `wal`、`foreign_keys` 确认为 `1`。
19. **方言不泄漏**：静态检查（`go list` + 正则）断言 `internal/service/**` 与 `internal/handler/**` 中不出现 `repository/postgres`、`repository/sqlite` 的 import。
