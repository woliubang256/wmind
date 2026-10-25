# Agent Note: OpenAI 兼容 Provider 与 AI 生成导图

Status: implemented

## Problem

用户需要从一句要求或 Word、Excel、PDF、图片生成一份可继续编辑的导图。站点当前只有格式导入，不能整理非导图材料；AI 入口还需要由管理员控制并保护 Provider 密钥。

## Decision

- 单个 OpenAI 兼容 Provider 使用 `/chat/completions`，配置包含 enabled（默认 false）、baseUrl、apiKey、model。`ai.config` 存在现有 settings 表，以独立域的 AES-GCM 加密；管理员响应只带 apiKeySet，空密钥保留旧值。每次读取配置从库读取，避免恢复和跨实例的过时开关。公开站点配置只增加 aiEnabled。
- 服务端固定追加提示词并在管理接口中只读展示，拒绝客户端传入替代提示词；用户明确要求先发用户输入和全部附件，再在同一 user 消息末尾追加格式指令，不使用前置 system 消息。纯文本保持字符串，有图片使用有序内容块，最后一块始终是追加提示词。不依赖兼容端可能不实现的 structured-output 参数。模型仅输出 title/children 的 JSON 树，服务端限制响应大小、节点数、深度及标题长度。Provider 错误不回传原始正文或凭据。
- 生成接口只返回验证后的树，原生文档构造和保存沿用客户端既有工厂与创建 API；后端不复制编辑器的默认主题。生成不预建空导图，失败或取消没有需要清理的占位文件。保存继续受到属主和配额约束。
- 素材契约是用户要求加有序的 name/text/images 附件，每份至少有文本或图片。后端不信任浏览器提取结果，独立验证 100000 字符、5 份附件、12 张图片、实际 MIME/尺寸与 8 MiB 图片字节预算；请求上限 12 MiB。素材内容不得充当系统指令。
- 浏览器附件模块支持 docx/xlsx/PDF/PNG/JPEG/WebP/GIF：Office 复用 fflate 与 XML 解析器，解压前仅接受已知文本条目、单条 8 MiB、总解压 16 MiB，拒绝 DTD；Excel 按 workbook 顺序读取工作表，保留稀疏单元格坐标、共享/内联字符串及公式缓存值。原文件每份 20 MiB、合计 30 MiB，Office 不读取内嵌图片与版式。
- PDF.js 6.4.299 只在遇到 PDF 时加载，独立分块；worker、CMap、标准字体、WASM 全部由 Vite 输出本地资源，不依赖 CDN。每份最多 20 页，逐页提取文字，无文本页面渲染为 JPEG；普通图片缩放到最长边 1600 像素，透明区域白底，动画只取第一帧。超过文本或图像总预算时拒绝整个请求，不能静默截断附件。
- 每用户每分钟 5 次，同用户一次并发生成，每进程最多 4 个。调用超时 100 秒，短于现有代理 120 秒超时。拒绝 Provider 重定向，避免共享密钥跟随跳转；原始错误不进入响应或日志。

## Scope

当前实现覆盖后端配置和生成 API、浏览器附件提取与原生文档转换。生成弹窗与后台配置界面在本篇的后续同功能提交中同步记录。

## Related decisions

- [站点设置](../../implemented/architecture/2026-10-17-wmind-site-settings.md)：部分重叠，保留通用快照和白名单公开；私有 AI 配置由独立服务持有，不进入通用设置响应。
- [导入框架](../../implemented/architecture/2026-10-20-wmind-import-framework.md)：部分重叠，Office 提取复用 fflate 与解压前预算思想；AI 材料不经过导图格式探测，也不更改已有导入语义。
- 搜索 proposed/implemented/rejected 的 AI、OpenAI、Provider、人工智能关键词，没有现成 AI 决策需要取代；导图持久化中 AI 仅是未来扩展点。

## Alternatives considered

- 服务端解析所有原文件：调用边界集中，任何客户端都可上传；但扫描 PDF 需要额外渲染依赖，Office/PDF 处理进入 API 进程。选择浏览器提取，后端仍强制检查最终文本和真实图片预算。
- 模型直接输出完整 wmind 文档：可以单请求创建；但模型容易漏掉复杂样式字段，后端也必须复制默认主题。采用受限树加现有文档工厂，格式与主题不分叉。
- 前端直接调用 Provider：少一层后端转发、取消直观；但会把全站共享密钥暴露给所有用户，且无法强制开关和提示词，因此调用只在后端进行。
- 使用 OpenAI 文件上传或 response_format JSON Schema：结构可靠、原文件省去提取；兼容服务对这两类能力支持不同，选用通用文本/图片消息与服务端验证。

## Verification

- `go test ./internal/ai ./internal/settings ./internal/httpapi -run 'TestAI|TestConfiguration|TestGenerate|TestRejectsInvalid|TestSiteConfig|TestOpenAPI' -count=1`：默认关闭、匿名/普通用户管理权限、只读提示词拒绝写入、密文存储、重建服务后解密、不同密钥失败、空密钥保留、其他实例立即读取更新；mock HTTP 验证文本/图片消息、完整路径与认证、取消、重定向拒绝、错误脱敏、模型树与输入预算。
- 路由与 OpenAPI 对等检查包含新增 3 个操作，公开响应仅增加 aiEnabled，通用设置响应不包含 ai.config。
- `pnpm test src/features/ai/attachments.test.ts`：独立 OOXML 样本验证 Word 段落、表格与拆分文本，Excel 多表顺序、字符串和坐标；验证损坏、空文件、DTD、压缩炸弹与共享字符/图片预算。生成文件经过真实 parseDocument，无归一化修复，保留完整层级、默认主题和字面标题。

## Consequences

- 图片与扫描 PDF 依赖所选模型支持视觉；上下文与输出容量因 Provider 而异，限制内的请求仍可能被其拒绝。
- 树契约隔离复杂文件格式，允许复用默认主题与普通创建权限；代价是生成与保存分两次请求。AI 输出是整理结果，可能遗漏或产生错误，用户需检查。
- 浏览器解析省去服务端 Office/PDF 运行组件，代价是按需下载 PDF.js 及本地资源、浏览器内存占用；带文字 PDF 中的内嵌图片当前不另传。扫描页不提供页内 OCR，由视觉模型理解页面图片。
- 配置按请求读库，在配置与生成频率下省去跨实例缓存失效机制；代价是公开配置请求也增加一次设置表读取。如果设置表规模增长，应增加按键仓储读取，不应缓存紧急关闭开关。
- 并发与频率限制按实例生效；多实例部署如需严格全局成本配额，应迁移到共享限流器。
- 现有导图创建 API 不具备跨网络重试幂等性；前端防重复和分阶段重试覆盖正常交互，连接在保存成功后丢失仍可能让用户需要回列表确认。
