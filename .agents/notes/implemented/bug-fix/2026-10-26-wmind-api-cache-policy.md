# Agent Note: API 响应统一禁止缓存

Status: implemented

## Problem

EdgeOne 遵循源站 Cache-Control，当前公开站点设置和部分认证失败、404 响应没有缓存头。仅敏感处理器各自设置 no-store 无法覆盖中间件提前返回，容易落入 CDN 默认策略。

## Decision

在真实路由的全局中间件最前段为 /api 和 /api/ 下全部响应设置 no-store，覆盖 CORS、认证、限流、维护窗口和未匹配路由。上传图片继续由 MediaHandler 根据权限决定缓存，内置静态资源使用独立的内容哈希长期缓存策略。

已有笔记审计：[私有媒体访问](../../implemented/bug-fix/2026-10-26-wmind-private-media-access.md)与[登录加密](../../implemented/architecture/2026-10-24-wmind-login-encryption.md)为部分重叠，继续拥有各自权限和凭证契约，本篇仅补齐 API 总体默认值；部署流程和字体笔记只描述其独立静态资源与发布边界。

## Alternatives considered

- 只在 Nginx 添加响应头，改动小且保护当前部署；但 API 直连和其他部署入口仍可能缺失，选择后端统一设置并由 Web 代理保持一致。
- 逐个接口设置缓存头，可为公开接口单独缓存；但设置和分享状态需要及时生效，提前返回容易遗漏，目前没有需要公开缓存的 API，统一 no-store 更可验证。

## Testing

真实 HTTP 路由测试先复现公开配置和认证失败缺少缓存头，修复后覆盖成功、401、404、错误方法、伪静态后缀和 /api 根路径。私有媒体仍 no-store，公开头像原有短缓存保持，由现有媒体权限回归验证。

## Consequences

公开配置每次重新访问服务端；这是让站点开关及时生效的取舍，字体、脚本等大资源不受影响。
