# Agent Note: 默认部署保留真实访客限流边界

Status: implemented

## Problem

默认 Compose 让 Nginx 代理 API，但未设置 WMIND_TRUSTED_PROXIES。Gin 因而按 Nginx 的容器 IP 限流，匿名访客共用注册、刷新与分享验密配额，一人用尽配额会阻止另一人的正常请求。直接信任所有代理或整个私网又会把伪造 X-Forwarded-For 变成绕过限流的手段。

## Decision

两个 Compose 默认建立独立的 172.31.254.0/29 桥接网络，API、Web 和可选 PostgreSQL 分别固定为 .2、.3、.4。API 默认只信任 Web 的精确地址 .3，不信任整个 Docker、RFC1918 或公网网段。子网及各容器 IP 均可配置；WMIND_TRUSTED_PROXIES 允许运维显式加入实际存在的上游代理，默认随 WMIND_WEB_IP 变化。API 不发布宿主端口。

Nginx 继续追加实际 TCP 对端至 X-Forwarded-For，Gin 从右往左按受信链解析，外部自带的伪造前缀不能覆盖真实访客。站点如另有 TLS/CDN 代理，须明确配置其固定地址，不自动放宽信任。

## Related decisions

已检索限流、反代与部署笔记：[限流与登录锁定](../../implemented/architecture/2026-10-17-wmind-rate-limit.md)保留内存桶、配额与多实例限制，本篇补齐默认部署提供正确 ClientIP 的前提；[后台备份](../../implemented/feature/2026-10-24-wmind-admin-backup.md)处理恢复代理路径，与本篇真实客户端边界部分相关但不替代。没有完全重复或需要归档的旧笔记。

## Alternatives considered

- 信任整个 Docker/RFC1918 网段适配动态容器地址且配置最少；但同网其他容器和额外代理都能成为可信转发者，扩大伪造面，因此仅固定 Web 地址。
- 保持不信任任何代理能拒绝伪造 IP，但会把所有访客合并到 Web IP 配额，默认部署不能正常隔离用户，因此配置专用代理信任。
- Nginx 覆盖 X-Forwarded-For 为 remote_addr 能丢弃所有自带头；但会永久丢失管理员明确部署的可信 TLS/CDN 链，保留追加方式并由精确地址信任解析。

## Verification

- 默认代理后不同访客配额互不影响，同访客用尽配额仍返回 429。
- 伪造 XFF 左前缀不能重置已有访客配额，未受信直连对端不能用 XFF 换 IP。
- 两个 Compose 使用相同默认边界，可同时调整子网/IP，不发布 API 与数据库端口。
- 自定义单个代理地址生效，相邻地址不获信任。
- `TestDefaultComposeSeparatesClientRateLimits` 先复现另一访客返回 429，修复后通过；`TestTrustedProxyCanUseExplicitCustomAddress` 覆盖显式自定义代理。`node --test deploy/proxy.test.mjs` 覆盖两个 Compose 的精确代理、专用网络、可配置地址与未暴露 API 端口。

## Consequences

默认部署按访客隔离限流，并将代理信任收窄到一个精确容器地址。代价是自选子网可能与宿主或 VPN 冲突，部署前须按示例同时修改子网与各容器地址。改变现有 Compose 网络 IPAM 通常需要重新创建容器网络并短暂中断；数据卷不变。没有 Docker 时仅执行配置契约和真实 Gin 请求验证，不宣称完成 Docker 网络集成测试。
