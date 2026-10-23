# Agent Note: 管理后台：按组鉴权、最后管理员保护、一次性重置密码

Status: implemented

## Problem

M1-5 要给管理员一套用户管理接口（列表/创建/编辑/禁用/删除/重置密码/统计/审计）。docs/04 §5.9 给了接口形状，但有几处需要自己定：

- 「不能降级或删除最后一个管理员」到底以什么为判据？
- 禁用用户后，已签发的 Access Token 怎么立刻失效（验收标准 3 要求「立即」）？
- 重置密码的明文只出现一次——它不能进日志、不能进审计，那审计记什么？
- 审计写入失败时，管理操作该不该失败？
- 审计列表要按 `action` / `actor_uid` / 时间筛选，而表里存的是自增主键。

## Decision

### 整组挂鉴权，而不是逐个接口加

```go
g := v1.Group("/admin",
    middleware.RequireAuth(deps.Sessions),
    middleware.RequireRole(domain.RoleAdmin))
```

管理接口漏一个鉴权就是全站权限失守。逐个接口加 `RequireRole` 时，新加一个接口忘了写是很容易发生且很难在 review 中看出来的；按组加只需要检查 `registerAdmin` 这一处。

### 最后管理员的判据是「当前可用管理员数 ≤ 1」

`guardLastAdmin` 在降级或禁用**之前**检查 `CountActiveAdmins() <= 1`。

判据不是「表里还有几个 role=admin」——已经被禁用的 admin 帮不上忙，按记录数算会允许把最后一个**可用**管理员降级，结果是没人能进后台。所以仓储提供的是 `CountActiveAdmins`（`status = active AND role = admin AND deleted_at IS NULL`）。

「禁用自己」没有单独的 `ADMIN_CANNOT_DISABLE_SELF`：只有一个管理员时它被最后管理员规则拦住；有多个管理员时，禁用自己可以由另一个管理员恢复，不需要额外禁止。错误码表里也没有这个码，加一个码意味着前端多一条分支。

### 禁用 = 撤销 refresh token + 失效状态缓存，两步都要

- 只撤令牌：已签发的 Access Token 还能用满 15 分钟。
- 只失效缓存：对方可以用 refresh token 续期。

`revokeSessions` 同时做两件事，并通过 `UserStatusInvalidator` 接口调 `AuthService.InvalidateUser`。接口而不是直接依赖 `*AuthService`：管理服务只需要「让缓存失效」这一个能力，声明成接口后测试可以传一个记录调用的假对象。

### 重置密码：明文只在响应里，审计只记「发生了什么」

- 密码为空 → `auth.GeneratePassword(16)` 随机生成（crypto/rand，字符集去掉 0/O/1/l/I 等易混淆字符——管理员往往要口头或手抄转告）。
- 指定密码 → 与注册同一套策略（最小长度、72 字节上限、弱密码黑名单）。
- 返回 `{password, generated}`，**仅此一次**。
- 审计 detail 是 `{generated, username}`，绝不含密码。测试里有一条断言：遍历审计 detail 的所有字符串值，任何一个等于新密码就失败。
- 同时撤销该用户全部 refresh token 并失效缓存（验收标准 7 的「其它设备会话全部失效」）。
- 禁止重置自己（`ADMIN_CANNOT_RESET_SELF`）：重置会踢掉当前会话，等于把自己锁在门外；改自己的密码走 `POST /users/me/password`（保留当前设备）。

### 审计写入失败只记日志，不让操作失败

`Record` 内部把错误吞掉并打 ERROR。理由：审计失败时操作**已经生效**（比如密码已经改了），返回 500 会让管理员重试，而重试会再执行一遍——重置密码尤其糟糕，第二次会生成第二个密码，第一个就永远丢了。

代价是极端情况下会丢审计记录。这个取舍是明确的：可用性优先于完整性，但错误日志里必须留下痕迹。

### 一条审计记录只写一个动作

`auditUserChange` 按「实际改了什么」分别写 `user.role` / `user.disable` / `user.enable` / `user.update`，而不是统一写 `user.update`。审计页要能按动作筛选，「谁被降级过」与「谁改过昵称」是两个不同的追问，混成一个动作就答不了。

### 审计筛选：`actor_uid` 在 service 层换成主键

表里存 `actor_id`（自增主键），前端只有 `uid`。转换放在 `AdminService.ListAuditLogs`：拿 uid 查一次用户，`ErrNotFound` 时**返回空列表而不是 404**——「筛不到」是正常查询结果。

### SQL 里用 `COALESCE(narg, col)` 而不是 `narg IS NULL OR col = narg`

第一版写的是后者（更符合直觉，也更能用上索引），但 sqlc 会把参数类型推断成 `interface{}`——`IS NULL` 测试没有提供任何类型信息，两个方言都生成 `interface{}` 字段，等于把类型检查推迟到运行时。

改成 `action = COALESCE(sqlc.narg(action), action)` 后，参数与列直接比较，sqlc 能推出 `*string` / `*int64` / `pgtype.Timestamptz`。代价是比较不再 sargable，但审计表本来就按 `created_at DESC` 排序取前 N 条，索引照样用得上。

## Alternatives considered

- **逐个接口挂 `RequireRole`** — 路由声明更扁平。被否同上：漏一个就全站失守，而按组只需要看一处。
- **判据用「admin 记录数 ≤ 1」** — SQL 更简单（`COUNT(*) WHERE role='admin'`）。被否是因为被禁用的 admin 不解决问题，会让最后一个可用管理员被降级。
- **禁用用户时只改 status，靠 60 秒缓存自然过期** — 少一个依赖。被否是因为验收标准 3 明确要求「立即」；60 秒的窗口足够做很多事。
- **重置密码时把明文也写进审计** — 便于事后核对。被否：审计表是 append-only 且管理员可读，等于把密码永久留档；而且它会被备份、被导出。
- **重置密码返回后允许再次查看** — 管理员抄错时可以重看。被否：要存明文或可逆加密，与「服务端只存哈希」的整个认证模型冲突。抄错就再重置一次。
- **审计写入失败时回滚整个操作** — 保证审计完整性。被否是因为操作已经生效（密码已改、状态已写），回滚需要额外事务包裹且与「先写库后审计」的顺序冲突；且失败重试会重复执行副作用。
- **审计列表的 `actor_uid` 直接当主键解析** — 少一次查询。被否是因为把内部主键暴露成了对外参数，前端也没有这个值。
- **`map_strategy` 一期不接收** — 导图表在 M2 才有。被否：接口形状现在就该定下来，一期只做取值校验（`delete` / `keep`），M2 接导图仓储时补上实际处理。

## Consequences

- **收益**：禁用/删除/改角色后，目标用户的下一次请求就被拒（403 `AUTH_ACCOUNT_DISABLED`），refresh 也无法续期。
- **收益**：重置密码全流程闭环（验收标准 7、8）：管理员一次性拿到新密码 → 用户用它登录成功、旧密码失效 → 其它设备会话全部失效 → 关掉对话框后查不到。
- **收益**：所有敏感操作留痕，且审计里没有密码。
- **代价**：`DeleteUser` 一期只做软删除，导图策略参数被校验但不生效（M2 补）。软删除后该 uid 查不到（404），其邮箱/用户名也不会被释放——重新注册同一邮箱会撞唯一约束。
- `GET /admin/stats` 的早期占位约定由[真实统计](../bug-fix/2026-10-24-wmind-admin-statistics.md)部分取代；字段形状保持稳定，导图、存储和连续 14 天趋势接入真实业务记录。
- **已知限制**：审计表的 `action` 与 `actor_id` 筛选走 `COALESCE`，无法用索引；十万条以上会变慢。真到那个量级应该给 `(action, created_at)` 建索引或按时间分区。

## Verification

- `go test ./internal/auth/...`：生成的随机密码长度正确、能过自身策略、字符集内无易混淆字符、64 次生成无重复。
- `go test ./internal/repository/...`：契约测试新增审计筛选断言——按 action 计数、按未知 action 计数为 0、按 actor 计数、时间窗内 2 条、上界在过去时为 0（这条会在时间格式不一致时失败）。
- `go test ./internal/httpapi/...`：管理路由未登录 401 / 普通用户 403（5 个入口各验一遍）；列表带分页信封；创建用户 201 与弱密码 422、重复邮箱 409、非法角色 422；禁用后 `/auth/me` 立刻 403 且无法登录、重新启用后恢复；唯一管理员不可降级/禁用/删除；重置密码随机生成 16 位以上、新密码可登录旧密码不可、重置自己 409、指定弱密码 422、审计含 `generated` 但不含密码明文；审计按 action 筛选、未知 `actor_uid` 返回空列表；统计字段齐全；删除用户 204 后无法登录、重复删除 404、审计留痕。
- 生产二进制冒烟（`WMIND_SQLITE_PATH` 指向临时目录）：创建用户 201、`?q=` 精确筛出 1 条、禁用后 `/auth/me` 立即 403 `AUTH_ACCOUNT_DISABLED`、审计同时留下 `user.create` 与 `user.disable` 且 detail 为 `{from,to}`。
