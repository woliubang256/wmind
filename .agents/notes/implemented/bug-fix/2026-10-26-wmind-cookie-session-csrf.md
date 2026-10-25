# Agent Note: Cookie 会话接口拒绝跨站写入

Status: implemented

## Problem

刷新接口在没有 Cookie 时从任意 Content-Type 解析 JSON；攻击者能用 text/plain HTML 表单提交自己的 Refresh Token，响应设置登录 Cookie。CORS 仅阻止读取响应，无法阻止简单跨站请求的副作用。SameSite=Lax 不防止顶层跨站导航响应写入 Cookie。

## Decision

全部能写入或清理认证 Cookie 的接口，在调用服务前校验 Origin 与 Fetch Metadata。Origin 必须是当前站点或显式配置的 CORS 允许来源；Origin 缺失时拒绝 cross-site/same-site 的 Fetch Metadata，保留无浏览器头的非浏览器客户端。拒绝导航和 no-cors 模式；合法开发前后端跨端口通过现有 CORSOrigins 精确授权。

有请求体时仅接受 application/json（允许 charset 参数），认证 JSON 最多 4 KiB，拒绝未知字段和多份 JSON。Cookie 优先于 body Refresh Token 的既有规则保留；合法同源空体 Cookie 刷新继续可用。拒绝的跨站请求不得签发、轮换、撤销令牌或设置/清除 Cookie。安全策略不信任任意 X-Forwarded-* 头，同源协议从 Cookie Secure、真实 TLS 或已解析请求 URL 确定。

## Related decisions

检索 Cookie、CORS、CSRF、刷新令牌后，[认证会话](../../implemented/architecture/2026-10-17-wmind-auth-session.md)部分重叠，本篇补充浏览器请求边界，保留 Cookie 范围和轮换策略。[启动恢复](../../implemented/bug-fix/2026-10-25-wmind-session-bootstrap.md)继续使用空体同源刷新；[登录信封](../../implemented/architecture/2026-10-24-wmind-login-encryption.md)继续持有密文挑战协议，JSON 入口收紧不改变密码格式。其余管理员撤权、2FA 和备份笔记不替代。

## Alternatives considered

- 只限定 application/json 能阻止普通 HTML 表单，改动很小；但会话 Cookie 清除接口可空体，且不能明确阻止可信站点配置外的浏览器来源，因此另加来源与 Fetch Metadata 守卫。
- 双重提交 CSRF Token 是成熟方案，支持不提供 Origin 的旧浏览器；但引入新的 Cookie、令牌交付和前端状态，当前同源 SPA 和显式开发来源已具备可信源边界，优先复用。
- 删除 body Refresh Token 能缩小接口，但会破坏非浏览器客户端；无 Origin/Fetch Metadata 的严格 JSON 模式可保留兼容。

## Verification

`TestSessionRefreshRejectsCrossSiteForms` 先复现 text/plain 和跨站 JSON 均200并设置会话 Cookie，修复后均403且无 Set-Cookie。真实路由测试覆盖同源、空体 Cookie、无 Origin 非浏览器 JSON、Cookie 优先；非法 MIME、超限、未知字段和尾随 JSON 被拒绝；注册、登录、2FA 和登出共用守卫。`TestBrowserSessionOriginBoundaries` 覆盖允许的开发跨端口来源、协议/端口不一致、opaque Origin、伪造 X-Forwarded-Proto、无 Origin 的同站与跨站 Fetch Metadata。拒绝的登出请求不会撤销受害者 Cookie。

## Consequences

登录 CSRF 在产生任何 Cookie 副作用之前被拒绝，开发跨端口和原生 JSON 客户端继续可用。自定义跨域前端必须在 CORSOrigins 配置精确来源。缺失所有浏览器来源头的客户端无法仅靠 HTTP 区分来自浏览器还是原生客户端，因此同时依赖严格 JSON MIME 与浏览器禁止跨站简单 JSON 请求的规则。大请求恢复不受认证小请求体上限影响。
