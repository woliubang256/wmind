# wmind 后端设计与 API 规范

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.3 |
| 编写日期 | 2026-10-16 |
| 状态 | 已确认（分享链接已纳入一期；邮件服务（SMTP）调整为二期；**数据库为 PostgreSQL + SQLite 双方言**，见 [09](./09-技术决策记录.md) ADR-015） |
| 技术栈 | Go 1.23 · Gin v1.10 · PostgreSQL 16（pgx v5）或 SQLite（modernc.org/sqlite）· sqlc · golang-migrate |
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
- `share.public_link_enabled = false` → 403 `SHARE_DISABLED`。
- `share.require_password = true` 且未提供密码 → 422 `VALIDATION_FAILED`。
- 超过 `share.max_links_per_map` → 403 `SHARE_LIMIT_REACHED`。
- 创建与撤销均写入 `audit_logs`。

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
- 写入审计日志：`action = admin.user.reset_password`，记录操作人、目标用户、时间、IP，**不记录密码**。

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

> **二期归档接口**：`POST /admin/mail/test`（发送测试邮件，支持传入未保存的 `config` 以便「先测再存」，失败返回 `MAIL_SEND_FAILED` 并带 `details.stage = connect | tls | auth | send`）一期不注册，设计见 [09-技术决策记录](./09-技术决策记录.md) ADR-012。

### 5.10 接口汇总

| 分组 | 数量 | 说明 |
| --- | --- | --- |
| 公开 | 3 | health ×2、site config |
| 认证与个人 | 7 | register / login / refresh / logout / me / password / avatar |
| 导图 | 12 | 列表、创建、读取、保存、重命名、删除、复制、缩略图、回收站 ×4 |
| 模板 | 4 | 列表、创建、改名、删除 |
| 主题 | 4 | 列表、创建、更新、删除 |
| 文件 | 3 | 上传、读取、删除 |
| **分享** | **6** | 创建、导图维度列表、我的分享、修改、撤销、公开读取、密码校验（含公开接口共 6 个） |
| 导出 | 1 | 服务端兜底导出 |
| 管理 | 10 | 用户 ×5、设置 ×2、统计、日志、重置密码 |
| **合计** | **50** | 相比 v1.1 的 55 减少 5 个（`forgot-password` / `reset-password` / `verify-email` / `resend-verification` / `admin/mail/test`） |

> 二期接入邮件后恢复为 55 个。`POST /admin/users/{uid}/reset-password` 一期即为正式接口（非占位），二期也不会移除——它与邮件重置是并存的两条找回路径。

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
| 403 | `THEME_BUILTIN_READONLY` | 内置主题不可修改 |
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

- **`queries/shared` 被两个 target 同时读取**。同一份 `.sql` 生成两套 Go 代码，占位符由 sqlc 按 engine 自动转换（PG 生成 `$1`，SQLite 生成 `?`）。
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
