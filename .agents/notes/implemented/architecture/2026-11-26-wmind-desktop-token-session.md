# Agent Note: 桌面云端会话使用原生双令牌与加密恢复

Status: implemented

## Problem

真实服务端仅通过 Set-Cookie 交付刷新令牌，桌面云端客户端却只解析 JSON；真实登录成功后 RefreshToken 为空，访问令牌默认 15 分钟到期后无法续期。本机日志包含连续续期失败，隔离真实后端复现相同行为。启动用加密保存的密码重登，也无法正确恢复开启 2FA 的会话，断网启动后没有可恢复的客户端。

## Decision

- 桌面原生请求以 `X-Wmind-Client: desktop` 显式选择 JSON 令牌交换；拒绝携带 Cookie、Origin 或 Fetch Metadata 的混合请求，不改变浏览器的 HttpOnly Cookie、CSRF 与 JSON 边界。访问令牌仍是默认 15 分钟的 JWT；刷新令牌复用服务端哈希存储、事务轮换、共享安全版本与即时撤权，桌面有效期为 30 天，每次续期从成功签发时滚动计算。刷新沿用原会话的 platform，不通过更换请求头提升期限。
- 原生成功响应包含 refreshToken / refreshExpiresAt，不设置 Cookie。刷新与退出在 JSON 请求体提交刷新令牌，普通 API 只带 Bearer；登录与 2FA 仍使用现有加密挑战及限流。

## Related decisions

检索 desktop、cloudcreds、Cookie、刷新令牌后：[桌面架构](../../implemented/architecture/2026-11-08-wmind-desktop-client.md)部分重叠，保留本地 BFF、同步与本地数据库凭据选择，本篇替代云端 Cookie 与密码自动重登。[认证会话](../../implemented/architecture/2026-10-17-wmind-auth-session.md)仍持有随机刷新令牌哈希、轮换重放检测与 Web Cookie；本篇只增加原生交付及桌面期限。[Cookie 来源守卫](../../implemented/bug-fix/2026-10-26-wmind-cookie-session-csrf.md)仍有效，新增原生模式不能绕过浏览器边界。[安全撤销到期](../../implemented/bug-fix/2026-10-26-wmind-refresh-revocation-expiry.md)、[管理员撤权](../../implemented/bug-fix/2026-10-25-wmind-admin-session-revocation.md)及[启动恢复](../../implemented/bug-fix/2026-10-25-wmind-session-bootstrap.md)部分重叠，继续沿用共享数据库安全状态与不可用不等于登出的原则；没有完全被吸收的旧篇。

## Alternatives considered

- Cookie jar 可以最小成本兼容现有服务器，也能自动轮换；但客户端退出多日后的持久恢复仍需要独立存储策略，用户明确选择原生双令牌，不继续把 Web 会话协议当作桌面持久鉴权。
- 保存密码并在令牌过期时自动重登能长期免交互；但绕过会话撤销的意图、长期持有账号主凭据且无法无感通过 2FA，因此移除。
- 两个令牌都签为 JWT 可统一结构；刷新仍需数据库轮换与即时撤销，现有高熵随机令牌及哈希仓储已具备这些性质，额外签名不解决当前故障，保留访问 JWT + 有状态随机刷新令牌。
- 系统钥匙串提供独立于数据库的密钥保护；现有 ad-hoc 签名升级会反复触发钥匙串授权，沿用本机密钥派生 AES-GCM，只有刷新令牌留在受限目录。

## Verification

服务端复现测试先失败后通过：原生登录不发 Cookie、返回 15 分钟访问令牌与 30 天刷新期限、10 天后可续期、30 天边界失效、Web 不泄露刷新令牌、浏览器混用模式无副作用。服务层覆盖更换 transport 不能改变原会话的有效期。所有测试使用临时目录与临时数据库。

## Consequences

需要服务器与客户端都更新，旧服务器不提供原生 JSON 刷新令牌时不能安全维持客户端登录。协议复用既有登录与刷新接口，Web 不暴露可读刷新令牌，也不新增数据库迁移。轮换 HTTP 响应完全丢失时无法安全重用旧令牌，需重新登录，不增加无条件重放宽限。30 天以上未成功续期须重登；此为会话期限而非程序打开时长。
