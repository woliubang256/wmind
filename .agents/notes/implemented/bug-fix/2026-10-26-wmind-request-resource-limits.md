# Agent Note: 普通请求解码与连接资源上限

Status: implemented

## Problem

头像、AI 与恢复已有独立请求体上限，但其余 JSON handler 直接解码输入；单独暴露后端时，超大未知字段也会先进入解码器，业务字段校验不能限制这部分内存。服务只设置请求头读取超时，空闲连接、请求头体积与缓慢请求体没有显式的应用边界。统一短读写超时又会中断合法的大备份上传与 AI 生成。

## Decision

路由全局中间件默认把请求体读取限制为 1 MiB；只有新建与保存导图的精确 POST/PUT 路由允许 16 MiB JSON 信封，服务原有 8 MiB 文档约束继续生效。主题实际最多 64 KiB，使用普通限制，不按路径前缀放宽。已声明独立限额的 AI、文件、头像与 ZIP 恢复预检仅在实际 POST 路由沿用各 handler 的更具体上限，后端鉴权仍先于上传读取。

已知 Content-Length 超限在解码前返回既有 413 FILE_TOO_LARGE；未知长度使用 MaxBytesReader，解码器最多读取额度内的内容，沿用各 handler 的解析失败响应。中间件不预读或缓冲完整输入，不为获得统一错误码提前读取未认证请求。

使用 ResponseController 对当前请求设置读取截止时间：普通请求体最多 2 分钟，专门上传最多 15 分钟；处理结束恢复读取截止时间，长 AI 推理与恢复处理不受短写超时影响。服务请求头超时保留 10 秒，显式 IdleTimeout 为 60 秒、MaxHeaderBytes 为 32 KiB，不设置全局短 WriteTimeout。

## Related decisions

检索请求体、代理、AI、导图持久化与备份笔记后，[导图持久化](../../implemented/architecture/2026-10-18-wmind-map-persistence.md)继续决定文档业务上限，[AI 生成](../../implemented/feature/2026-10-25-wmind-ai-generation.md)、[后台备份](../../implemented/feature/2026-10-24-wmind-admin-backup.md)与[图片上传](../../implemented/architecture/2026-10-20-wmind-file-upload-images.md)继续决定独立上传额度，本篇只补普通解码和连接预算。Cookie 防跨站单元持有认证 JSON 的更小限额和严格解析，不相互替代。没有完全吸收或需归档的旧笔记。

## Alternatives considered

- 只依赖 Nginx 的 16 MiB 限制无需改应用，容器部署也能挡住超大请求；但二进制部署和内部直连没有该边界，普通匿名 JSON 也不需要这么大额度，因此应用独立设置较小上限。
- 在中间件预读全部 body 能统一检查长度并返回 413；但会在鉴权前读取大上传并重新缓冲所有输入，所以仅包裹读流，保留鉴权与专门上传处理顺序。
- 全局设置短 ReadTimeout/WriteTimeout 配置最直接；但会误伤 2 GiB 恢复和长 AI 生成，因此仅对读取请求体设置分路由时限，保留应用和代理已有的业务超时。

## Verification

- 普通已知长度超限在 handler 前拒绝，未知长度读取不超过 1 MiB。
- 导图保存可超过 1 MiB 但不超过普通代理 16 MiB，分享、主题、恢复确认等不继承大额度。
- AI、头像、文件、恢复预检沿用自身上限；相似路径、错误方法不能获得豁免。
- 普通与上传读截止时间不同，请求结束清理截止时间；不增加会中断长响应的统一写超时。
- `TestRouterBoundsOrdinaryBodiesBeforeHandlers` 先复现已知/未知长度超限仍读完且成功，修复后通过；`TestRouterKeepsLargeDocumentAndDedicatedUploadPaths` 覆盖导图、大上传和相似路由不被放宽。`TestRequestReadDeadlineIsScopedAndCleared` 验证两类截止时间与清理，`TestRequestLimitsNeverReadBeforeAuthentication` 验证大上传鉴权前不读取 body。
- 正式 Go 1.26.10 下 `WMIND_TEST_DATABASE_URL= go test ./internal/httpapi/... ./cmd/server -count=1` 全部通过，覆盖现有认证、分享、AI、备份、导图及上传契约；使用隔离数据库和目录，不访问线上。

## Consequences

应用不依赖外层代理也具备普通解码、请求头、空闲连接和请求体读取预算，大上传与长响应保留独立处理能力。代价是已有非标准客户端若依靠普通 JSON 超过 1 MiB 的未知字段会被拒绝。HTTP/1 请求超限可能关闭连接，客户端需重建；未知长度超限错误仍由 handler 翻译，不强行统一成 413。测试 ResponseController 能力与真实 router 包裹，未进行公网慢连接或容量压测，不能据此宣称完全解决所有资源耗尽攻击。
