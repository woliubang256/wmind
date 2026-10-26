# Agent Note: Nginx 静态缓存与动态代理边界

Status: implemented

## Problem

真实 Nginx 回归复现了固定字体 CSS 不可直接缓存、静态 404 带 public/immutable、缺失字体 CSS 返回 SPA 200，以及字体扩展名抢占 /api/ 代理。遵循源站头的 EdgeOne 会继承这些错误语义。固定编号字体曾使用一年 immutable，文件更新不可靠。

## Decision

只给成功的哈希资源长期缓存。按响应状态分别产生 /assets/ 的一年 immutable 与固定资源的一小时缓存头，错误统一 no-store。/fonts/ 和常见静态扩展名使用 try_files $uri =404；普通应用路由仍回退 index.html 并 no-cache。API 使用优先前缀与 no-store，精确备份路由同样覆盖上游缓存头；上传在 200/206/304 时保留后端显式策略，不改公开头像与私有图片的区分，缺头或错误时统一 no-store，覆盖未知多级路径和 Nginx 生成的 502。所有 location 保留现有安全头。

### 归属审计

[资源内容版本](../../implemented/architecture/2026-10-26-wmind-static-resource-cache.md)提供 immutable 所需的哈希 URL，本篇补充代理状态语义；[私有媒体权限](../../implemented/bug-fix/2026-10-26-wmind-private-media-access.md)继续持有授权和上传缓存，不能用通用静态规则覆盖；[代理客户端边界](../../implemented/bug-fix/2026-10-26-wmind-proxy-client-boundary.md)的可信来源处理不变。无笔记被完全取代。

## Alternatives considered

- 全站统一长期缓存只需一条 CDN 规则，但会缓存私有响应和入口 HTML，故只按资源身份开放。
- 使用 expires 与 add_header 分别输出时长和 immutable 是常见配置，HTTP 允许合并多条头；但 always 会把 public/immutable 附到错误响应，状态映射输出单一完整头更容易验证。
- 仅用源码正则测试无运行环境成本，但发现不了 Nginx location 选择和继承的真实结果；保留既有打包契约，并新增临时目录与假 API 的 HTTP 测试。

## Testing

本机 Nginx 1.31.8 的真实 HTTP 回归验证 200/206/304 的头一致、404 不缓存不返回 SPA、API 后缀路径完整代理、备份根无重定向、上传私有与头像缓存保持、API/上传的 502 no-store 和安全头全部存在。追加回归先复现上传多级 404 和 502 缺头，再验证无策略的成功响应及带公共头的上游 500 也不缓存。测试使用独立临时目录与随机端口，结束关闭实例，不启动系统服务。`WMIND_REQUIRE_NGINX=1 npm run test:release` 共 32 项通过；原部署包契约继续核对代理配置。

无 nginx 的普通开发环境可跳过运行测试，WMIND_REQUIRE_NGINX=1 将环境缺失视为失败。发布 CI 在安装 Nginx 时临时 mask 服务避免自动启动，并强制真实 HTTP 测试，不让缺少运行时悄悄跳过回归。

## Consequences

固定旧路径最多缓存一小时，内容更新可能延迟；新应用采用内容哈希避开此问题。已发给客户端的旧一年缓存不能靠新响应头收回，新哈希 URL 才是失效方式。真实回归使用本机 nginx，与生产补丁版可能不同；CI 的部署冒烟继续覆盖实际镜像。
