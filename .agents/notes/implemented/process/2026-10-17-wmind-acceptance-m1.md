# Agent Note: M1 验收：11 条标准的证据、不适用项与文档漂移

Status: implemented

## Problem

M1 的验收标准有 11 条，覆盖注册开关、越权、令牌失效、最后管理员、静默刷新、账号锁定、重置密码全流程、暗色模式、方言对等。要把它们逐条给出**可复核的证据**，有三个现实约束：

- 本机没有 Docker，也没有 PostgreSQL。第 11 条（方言对等）在本地无法完整验证。
- 仓库没有 E2E 框架（Playwright Test / Cypress 都不在依赖里）。第 5、10 条是纯浏览器行为，`go test` 与 Vitest 都覆盖不到。
- 第 2 条（用户 A 访问用户 B 的导图 → 404）在 M1 根本没有被操作的对象：`maps` 表已建，但没有任何导图接口。

含糊地写「全部通过」会让下一个人以为这些都被自动化覆盖了。真正需要写清楚的是：**哪几条被什么证据支撑、哪几条现在验不了、为什么**。

## Decision

### 分两层验证，各用最小工具

- **接口层**：一个 curl + python 的脚本，直接打真实二进制（`backend/bin/wmind-server`，临时 SQLite）。断言状态码与 `error.code`，不解析自然语言文案。
- **界面层**：`playwright-core` + 本机缓存的 chromium，对「真实后端 + Vite dev」跑完整用户路径并截图。没有引入 Playwright Test，是因为这一期只需要一次性核验，而引入它意味着 `pnpm install` 多一个浏览器下载步骤、CI 多一段 `playwright install`——那是 M6 的 E2E 任务。

### 令牌过期的验证方式：把 TTL 调短，而不是等 15 分钟

用 `WMIND_ACCESS_TOKEN_TTL=25s` 启动后端，登录后等 30 秒，再用**客户端导航**（点侧栏，不刷新页面）跳到概览页——那里同时发 `stats` 与 `audit-logs` 两个请求，正好构成「并发 401」。统计 `/auth/refresh` 的请求次数，增量必须是 1。

用整页刷新做这件事是不行的：访问令牌只存在内存里，刷新页面必然触发一次刷新，测不出「并发合并」。

### 账号锁定要排除 IP 限流的干扰

`/auth/login` 上有 5 次/分钟/IP 的令牌桶。连打 5 次错误密码后，第 6 次请求会先撞上 IP 限流（`RATE_LIMITED`），从而**掩盖**账号锁（`AUTH_TOO_MANY_ATTEMPTS`）。两次 429 的码不同，混在一起就会误判成「锁定没生效」。

所以第 6 次之前要等 65 秒让桶回填，再用**正确密码**登录：仍然 429 `AUTH_TOO_MANY_ATTEMPTS`，才说明锁的是账号而不是 IP。

### 不适用项明确标注，不硬凑

第 2 条标注为「M1 不适用，推迟到 M2」，理由写在结果表里。M1 的越权面由「admin 组整体挂鉴权」覆盖（`go test` 已断言 5 个管理入口对未登录 401、对普通用户 403），但「A 访问 B 的资源」需要资源级接口才能测，M2 引入导图后补。

### 方言对等：本地只验 SQLite，PG 交给 CI，并明确写出「半开」

`go run ./cmd/verifyparity` 在没有 `WMIND_TEST_DATABASE_URL` 时会打印「已跳过 PostgreSQL 结构比对」并返回 0。这个「半开」行为是刻意设计的（本地不装 PG 也能跑），代价是**本地绿 ≠ 方言一致**。CI 的工作流带 `postgres:16-alpine` service 并设置该变量，契约测试因此会在两种方言上各跑一遍。第 11 条在本地结论是「SQLite 通过，PG 待 CI 复核」。

## Alternatives considered

- **引入 Playwright Test 作为正式 E2E 套件** — 可复用、可进 CI。被否：M6 明确列了「E2E 测试」，现在引入等于提前做一半并留下半成品；本期的脚本是一次性核验，不追求可维护性。
- **用 jsdom / happy-dom 做组件测试覆盖第 5、10 条** — 不用真浏览器。被否：`matchMedia`、`localStorage` 首帧时序、`<dialog>.showModal()` 在 jsdom 里要么缺失要么行为不同，测出来的绿是假的。真正想验的正是浏览器的行为。
- **等 15 分钟验证账号锁定自然到期** — 更接近真实。被否：一次验收等 15 分钟不可接受，且锁定逻辑已有单测（`internal/service` 的 `LoginThrottle` 用例）覆盖到期后的恢复。
- **第 2 条先标「通过」** — 表格更整齐。被否：这是最容易在 M2 变成真漏洞的一条，含糊过去等于给自己埋雷。
- **把验收脚本提交进仓库** — 可复现。被否：脚本依赖 `playwright-core` 与缓存浏览器，不在 `package.json` 里；提交一个「别人跑不起来」的文件比不提交更糟。步骤与断言写进本笔记，M6 做正式套件时以此为清单。

## Consequences

- **收益**：11 条标准各有明确结论与证据来源；3 条需要后续动作的（#2 推迟、#11 待 CI、#7 的「关掉后查不到」靠接口不存在保证）都写明了原因。
- **收益**：验收过程中发现的两个真实缺陷（对话框因 Tailwind preflight 清掉 `margin:auto` 而贴左上角、侧栏因纯前缀匹配同时点亮两项）在提交 M1-6 之前修掉，并补了回归说明。
- **收益**：文档漂移被集中修掉，`docs/02` / `docs/04` / `docs/05` / `docs/08` 与实现重新对齐（见下表）。
- **代价**：验收脚本不在仓库里，复现要靠本笔记的步骤描述。
- **代价**：第 11 条在本地是「半开」，真正的方言一致性只由 CI 保证。发布检查清单必须包含「CI 的 PG job 通过」这一条。

### 顺带修掉的文档漂移

| 文档 | 原文 | 实际 | 处理 |
| --- | --- | --- | --- |
| `04` §5.1 | `/site/config` 响应缺 `shareEnabled` | 有该字段（由 `share.public_link_enabled` 派生） | 补字段并说明白名单结构体 |
| `04` §5.9 | 重置密码审计动作 `admin.user.reset_password` | `user.reset_password` | 改正并补 detail 形状 |
| `04` §5.9 | 「未知 key 返回 `SETTINGS_INVALID`」 | 422 + `error.details.fields`，且「全通过才写」 | 补充语义 |
| `04` §5.9 | 审计动作无清单 | 8 个动作散落在代码常量里 | 补一张动作/detail 表 |
| `02` §3 | shadcn/Radix、lucide、zod、TanStack Table | 自建组件、内联 SVG、手写校验、原生 table | 按实现改正 |
| `05` §1.1 / §3.8 | 同上 + `AdminLayout` + 「输入用户名」二次确认 | 复用 `AppLayout`；删除确认未做输入校验 | 改正并写明偏差理由 |
| `08` §3 | M1 前端「表单校验（zod）」 | 手写 | 改为指向 `05` §3.8 |

## Verification

### 接口层（真实二进制 + 临时 SQLite，`WMIND_ACCESS_TOKEN_TTL=25s`）

```
1. 关闭注册        PUT /admin/settings {"auth.registration_enabled": false}
                   → registration_enabled = False
                   POST /auth/register → 403 REGISTRATION_CLOSED
9. 注册即生效      POST /auth/register → 201，data 键为 [accessToken, expiresIn, user]
                   requiresEmailVerification 不存在；user.status = active
                   GET /admin/settings → 20 个键，mail.* 前缀键 0 个
6. 账号锁定        第 1–4 次错误密码 → 401 AUTH_INVALID_CREDENTIALS
                   第 5 次 → 429 AUTH_TOO_MANY_ATTEMPTS
                   等 65s（IP 桶回填）后用正确密码 → 429 AUTH_TOO_MANY_ATTEMPTS
8. 不能操作自己    reset self → 409 ADMIN_CANNOT_RESET_SELF
                   delete self → 409 ADMIN_CANNOT_DELETE_SELF
                   降级唯一管理员 → 409 ADMIN_LAST_ADMIN
3. 禁用立即生效    create accept2 → 201；登录后 /auth/me → 200
                   PATCH {"status":"disabled"} → 200
                   同一令牌 /auth/me → 403 AUTH_ACCOUNT_DISABLED
                   POST /auth/refresh（伪造 cookie）→ 401
4. 审计留痕        user.reset_password {"generated": true, "username": "accept1"}
                   settings.update {"keys": ["auth.registration_enabled"]}
```

### 界面层（Playwright + chromium headless，真实后端 + Vite dev）

```
登录成功
过期前 refresh 次数: 1（登录时一次）
等待 30s 让 access token（25s）过期…
过期后 refresh 次数增量: 1 | 仍在 /admin: true
偏好: 跟随系统 | 系统深色 → true | 系统浅色 → false
DOMContentLoaded 时 html class: "dark" | localStorage: null
刷新后仍为深色: true
```

首帧那条的推理：`localStorage` 为 `null`（偏好取默认 `system`），而 `DOMContentLoaded` 时 `<html>` 已经有 `dark`。`useThemeStore` 在初始化时**不**写 class（只在 `setPreference` 时写），所以这个 class 只能来自 `index.html` 里那段在 bundle 之前执行的内联脚本。

### 逐条结论

| # | 标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 关闭注册后注册页不可达、接口 403 | 通过 | 接口 403 `REGISTRATION_CLOSED`；匿名 `/register` 渲染「暂未开放注册」页且无表单；登录页「立即注册」链接数 0 |
| 2 | A 访问 B 的导图 → 404 | **不适用（M2）** | M1 无导图接口；越权面由 admin 组鉴权覆盖（未登录 401 / 普通用户 403 ×5 入口） |
| 3 | 禁用后已签发 Access Token 立即失效 | 通过 | 同一令牌 200 → 403 `AUTH_ACCOUNT_DISABLED` |
| 4 | 不能删除自己 / 降级或删除最后管理员 | 通过 | 三个 409；界面按钮 disabled |
| 5 | 过期后静默刷新，并发只刷新一次 | 通过 | 2 个并发请求 → refresh 增量 1，页面未跳登录 |
| 6 | 连续 5 次密码错误锁定 15 分钟 | 通过 | 第 5 次 429 `AUTH_TOO_MANY_ATTEMPTS`；锁定期内正确密码仍 429 |
| 7 | 重置密码全流程 | 通过 | 16 位随机密码一次性返回 → 新密码可登录、旧密码失效（`go test`）→ 会话撤销（`go test`）→ 无接口可再查 |
| 8 | 不能重置自己（409 + 按钮禁用） | 通过 | 409 `ADMIN_CANNOT_RESET_SELF`；行按钮 disabled 且 title 说明原因 |
| 9 | 注册即生效、无邮件字段、无 `mail.*` | 通过 | 响应键 `[accessToken, expiresIn, user]`；20 个设置键中 `mail.*` 为 0 |
| 10 | 暗色模式三档、刷新保持、system 实时、首帧不闪 | 通过 | 见上；`theme-color` 同步为 `#111521` |
| 11 | 方言对等 | **半开**：SQLite 通过，PG 待 CI | 本地 `verifyparity` 明确提示已跳过 PG 比对；CI 带 `postgres:16-alpine` + `WMIND_TEST_DATABASE_URL` |

### 回归闸门（本批改动后重跑）

```
gofmt -l .                      → 无输出
go vet ./...                    → 通过
go run ./cmd/dialectcheck .     → ok: 方言未泄漏（internal/service, internal/handler）
go run ./cmd/verifyparity .     → ok: 两套迁移集一致（PG 部分跳过，见上）
go test ./...                   → 全部 ok
npm run verify-notes            → ok: 24 note(s)
tsc --noEmit / vitest run       → 0 错误 / 35 用例通过
vite build                      → 通过，无 chunk 体积告警
```
