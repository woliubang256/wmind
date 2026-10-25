# Agent Note: 自助改密原子撤销旧会话并换发当前会话

Status: implemented

## Problem

自助改密只撤销 Refresh Token，不推进 SessionVersion，因此其他设备的 Access Token 还能使用十五分钟。当前设备通过 Cookie 识别，但 Cookie Path=/api/v1/auth，不会发送到 /users/me/password；真实浏览器改密会丢失后续刷新能力。密码写入与会话撤销也不在同一事务。

## Decision

改密沿用安全行优先的事务锁协议：在锁内重新验证用户及密码快照，更新密码、安全版本、清理未完成挑战并撤销全部旧 Refresh Token，最后换发当前请求的新会话。任一步失败全部回滚。原有 2FA 状态与恢复码保留，已有第二因子挑战失效。

HTTP 成功返回 AuthSession 和新 Refresh Cookie，前端即刻替换内存 Access Token 及当前用户缓存。Cookie Path 仍收窄到 /api/v1/auth，当前请求身份由已验证 Access Token 和旧密码证明，不尝试读取不会发送来的 Cookie。

登录、刷新、2FA 和改密统一同步只读媒体 Cookie（Path=/uploads）。`auth/media_token.go` 使用独立 issuer=wmind-media，`service/media.go` 每次检查对应 Refresh Token 及活跃账号；媒体凭据不能用作访问或刷新令牌。签发两种 Cookie 前先完成媒体签名，避免部分写入；显式退出同时清理两种 Cookie。

刷新失败不写 Set-Cookie：旧设备请求可能在改密或新登录之后才返回，迟到的 Cookie 删除响应会覆盖浏览器已经收到的新凭据，内存代数无法防止浏览器应用响应头。旧 Cookie 按原到期时间保留，服务器仍拒绝已撤销、过期或禁用账号的凭据；前端把认证失效视为未登录，显式登录或退出再替换/清理 Cookie。短暂故障同样不删除会话 Cookie。

前端把操作级 `AUTH_INVALID_CREDENTIALS` 保留为错误提示，不把输错旧密码误判为 Access Token 失效；真正的令牌失效仍走现有单飞刷新与会话终止规则。

## Related decisions

检索认证、用户资料、SessionVersion、改密和双因素笔记后，[用户资料](../../implemented/architecture/2026-10-17-wmind-user-profile.md)的 Cookie 定位细节被本篇取代，其资料和头像决策保留。[认证会话](../../implemented/architecture/2026-10-17-wmind-auth-session.md)保留刷新轮换和 Cookie 范围；[管理员撤权](../../implemented/bug-fix/2026-10-25-wmind-admin-session-revocation.md)及[双因素认证](../../implemented/feature/2026-10-23-wmind-two-factor.md)的共享安全行锁和版本机制直接复用。相关备份和前端启动恢复笔记不改变本次决策，无需归档。

## Alternatives considered

- 扩大 Refresh Cookie 到 /api/v1 可直接识别旧设备，但会将凭据发送给更多接口，还需按设备区分 Access Token；整体换发会话能保持原 Cookie 范围并复用全局安全版本。
- 仅撤销其他 Refresh Token 能保持原响应格式，但无法即时撤销旧 Access Token；账号改密的安全预期要求推进安全版本。
- 全部撤销并要求当前用户重新登录实现简单，但当前请求已经证明身份，事务内换发能同时保持登录并保证旧凭据失效。

## Verification

HTTP 测试先复现改密后其他设备 Access Token 返回 200；修复后旧 Access Token 返回 401，200 响应包含替代会话，Cookie jar 可继续刷新。`TestSessionRefreshFailureCannotClearNewerSessionCookies` 先复现迟到401携带两条清 Cookie 响应头，修复后不再写 Cookie，新会话仍可刷新。两实例集成测试覆盖旧 Refresh Token 撤销、版本保存/撤销/换发失败的全部回滚、并发改密仅一个成功。既有双因素测试覆盖保留 2FA 设置且旧挑战失败。

## Consequences

全部旧 Access/Refresh Token 和媒体凭据在共享数据库上撤销，当前设备无需重新输入密码。[安全撤销到期边界](2026-10-26-wmind-refresh-revocation-expiry.md)确保旧设备正常刷新不会撤销替代会话。成功码由 204 改为 200，需要前后端同步更新。已通过鉴权的在途业务请求不主动回滚。PostgreSQL 未配置测试库时仅验证共享锁协议和编译。
