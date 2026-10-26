# Agent Note: OpenAI 兼容 Provider 与 AI 生成导图

Status: implemented

## Problem

用户需要从一句要求或文本、Word、Excel、PDF、图片生成一份可继续编辑的导图。站点当前只有格式导入，不能整理非导图材料；AI 入口还需要由管理员控制并保护 Provider 密钥。

## Decision

- 单个 OpenAI 兼容 Provider 使用 `/chat/completions`，配置包含 enabled（默认 false）、baseUrl、apiKey、model、reasoningEffort。思考等级默认空字符串，旧配置缺字段也解释为空；此时 Provider 请求必须完全省略 `reasoning_effort`，不传 null，也不替换成 none。显式选择 none/minimal/low/medium/high/xhigh/max 时按原值发送，服务端拒绝其他值。`ai.config` 存在现有 settings 表，以独立域的 AES-GCM 加密；管理员响应只带 apiKeySet，空密钥保留旧值。每次读取配置从库读取，避免恢复和跨实例的过时开关。公开站点配置只增加 aiEnabled。
- 服务端固定追加提示词并在管理接口中只读展示，拒绝客户端传入替代提示词；用户明确要求先发用户输入和全部附件，再在同一 user 消息末尾追加格式指令，不使用前置 system 消息。纯文本保持字符串，有图片使用有序内容块，最后一块始终是追加提示词。不依赖兼容端可能不实现的 structured-output 参数。模型仅输出 title/children 的 JSON 树，服务端限制响应大小、节点数、深度及标题长度。Provider 错误不回传原始正文或凭据。
- 生成接口只返回验证后的树，原生文档构造和保存沿用客户端既有工厂与创建 API；后端不复制编辑器的默认主题。生成不预建空导图，失败或取消没有需要清理的占位文件。保存继续受到属主和配额约束。
- 素材契约是用户要求加有序的 name/text/images 附件，每份至少有文本或图片。后端不信任浏览器提取结果，独立验证 100000 字符、5 份附件、12 张图片、实际 MIME/尺寸与 8 MiB 图片字节预算；请求上限 12 MiB。素材内容不得充当系统指令。
- 浏览器附件模块支持 docx/xlsx/PDF/PNG/JPEG/WebP/GIF：Office 复用 fflate 与 XML 解析器，解压前仅接受已知文本条目、单条 8 MiB、总解压 16 MiB，拒绝 DTD；Excel 按 workbook 顺序读取工作表，保留稀疏单元格坐标、共享/内联字符串及公式缓存值。原文件每份 20 MiB、合计 30 MiB，Office 不读取内嵌图片与版式。
- 文本附件明确支持 txt、md/markdown、csv/tsv、json、yaml/yml、xml、log、ini/conf/toml；同一扩展名集合同时驱动选择器、拖放校验与显式解析分支，不依赖浏览器 MIME。文本按原文发送，保留换行、缩进、分隔符、Markdown 标题与代码围栏，JSON/XML 等不解析、不渲染、不展开实体。先识别 UTF-8 或 UTF-16 LE/BE BOM，无 BOM 先严格 UTF-8，失败后严格 GB18030（兼容 GBK）；显式 BOM 解码失败不改用其他编码。拒绝 NUL、除 TAB/LF/CR 外的控制字符及非法字节，不用替代字符静默修复。纯文本解码按每字符最多 4 字节预检并逐码点计数，单份和总计 100000 字符上限均拒绝超限、不截断；文件大小、数量、顺序、取消与后端素材契约不变。
- PDF.js 6.4.299 只在遇到 PDF 时加载，独立分块；worker、CMap、标准字体、WASM 全部由 Vite 输出本地资源，不依赖 CDN。开发期预构建 PDF.js，避免首次解析触发 Vite 依赖重优化、整页刷新和素材丢失，不改变浏览器按需下载。每份最多 20 页，逐页提取文字，无文本页面渲染为 JPEG；普通图片缩放到最长边 1600 像素，透明区域白底，动画只取第一帧。超过文本或图像总预算时拒绝整个请求，不能静默截断附件。
- 每用户每分钟 5 次，同用户一次并发生成，每进程最多 4 个。调用超时 100 秒，短于现有代理 120 秒超时。拒绝 Provider 重定向，避免共享密钥跟随跳转；原始错误不进入响应或日志。

## Scope

实现覆盖后端配置和生成 API、浏览器附件提取、生成弹窗、原生文档转换与后台 AI 配置。最近列表的 AI 生成入口位于新建左侧，仅启用时显示；弹窗按需加载，允许文字、附件或组合输入。错误保留素材，取消中止旧请求且不创建文件；保存失败缓存已生成文档，仅重试保存，不再次计费调用 AI。保存阶段禁止关闭。后台短字段桌面并排、手机单列，追加提示词按需展开且只读。

附件既可点击选择也可拖入弹窗表单，上传区域在文件进入时高亮；嵌套元素切换用进入深度计数避免闪烁，最后离开或松手时清除。仅拦截文件拖放并阻止冒泡到背景导图导入；文字拖动保持原生行为。解析、生成及保存中仍阻止文件默认导航，但不接收新文件。拖放与点击共用去重、格式及大小/数量限制，失败不丢已有附件。

后台思考等级复用现有 SelectField，标签为「思考等级」，空值显示「不传」，其他选项直接显示 Provider 的枚举值；只保留一条模型兼容性提醒。Base URL/API Key 与 Model/思考等级桌面两行两列、手机单列。等级参与草稿变更检测，保存后及刷新恢复已存值；历史响应缺字段显示空值，不因新增字段清除 API Key。

## Related decisions

- 兼容消息结构参考 [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：user content 支持字符串或有序 text/image_url 内容块；只依赖基础消息契约，不假定兼容端实现所有 OpenAI 参数。
- [站点设置](../../implemented/architecture/2026-10-17-wmind-site-settings.md)：部分重叠，保留通用快照和白名单公开；私有 AI 配置由独立服务持有，不进入通用设置响应。
- [导入框架](../../implemented/architecture/2026-10-20-wmind-import-framework.md)：部分重叠，Office 提取复用 fflate 与解压前预算思想；AI 材料不经过导图格式探测，也不更改已有导入语义。
- 搜索 proposed/implemented/rejected 的 AI、OpenAI、Provider、人工智能关键词，没有现成 AI 决策需要取代；导图持久化中 AI 仅是未来扩展点。

## Alternatives considered

- 服务端解析所有原文件：调用边界集中，任何客户端都可上传；但扫描 PDF 需要额外渲染依赖，Office/PDF 处理进入 API 进程。选择浏览器提取，后端仍强制检查最终文本和真实图片预算。
- 模型直接输出完整 wmind 文档：可以单请求创建；但模型容易漏掉复杂样式字段，后端也必须复制默认主题。采用受限树加现有文档工厂，格式与主题不分叉。
- 前端直接调用 Provider：少一层后端转发、取消直观；但会把全站共享密钥暴露给所有用户，且无法强制开关和提示词，因此调用只在后端进行。
- 使用 OpenAI 文件上传或 response_format JSON Schema：结构可靠、原文件省去提取；兼容服务对这两类能力支持不同，选用通用文本/图片消息与服务端验证。
- 根据模型名推断思考等级并自动降级重试：可隐藏模型能力差异，但兼容 Provider 的别名无法可靠推断，而且重试可能再次计费。管理员显式选择、默认不传；不自动换模型、降级或重试，模型不支持时反馈调用失败。
- 对所有未知扩展名或 text/* MIME 自动当文本：兼容范围最大，但浏览器 MIME 不稳定，也会让新格式意外绕过解析边界；采用明确的常见文本扩展名清单，接入已确认格式时再扩展。
- 只支持 UTF-8：编码判断最明确、不会把其他格式误当 GBK，但常见 Windows 中文文本与带 BOM 的 UTF-16 会被拒绝；采用严格解码和控制字符拒绝，保留无 BOM 编码识别具有启发式的边界，不承诺识别所有旧编码。

## Verification

- `go test ./internal/ai ./internal/settings ./internal/httpapi -run 'TestAI|TestConfiguration|TestGenerate|TestRejectsInvalid|TestSiteConfig|TestOpenAPI' -count=1`：默认关闭、匿名/普通用户管理权限、只读提示词拒绝写入、密文存储、重建服务后解密、不同密钥失败、空密钥保留、其他实例立即读取更新；mock HTTP 验证文本/图片消息、完整路径与认证、取消、重定向拒绝、错误脱敏、模型树与输入预算。
- 路由与 OpenAPI 对等检查包含新增 3 个操作，公开响应仅增加 aiEnabled，通用设置响应不包含 ai.config。
- `pnpm test src/features/ai/attachments.test.ts`：独立 OOXML 样本验证 Word 段落、表格与拆分文本，Excel 多表顺序、字符串和坐标；验证损坏、空文件、DTD、压缩炸弹与共享字符/图片预算。生成文件经过真实 parseDocument，无归一化修复，保留完整层级、默认主题和字面标题。
- `text-attachments.test.ts` 在接入前 27 项因格式拒绝失败；接入后 29 项覆盖全部文本扩展名、大写与空 MIME、原文结构、UTF-8/BOM、UTF-16 双端序、GBK 与 GB18030 四字节、完整二进制检查、空文件、精确字符上限、混合 Office 顺序及取消。与既有附件/i18n 守卫共 41 项通过，类型检查通过，不更改后端素材或提示词契约。
- 独立 `node frontend/e2e/ai-text-attachments.mjs` 不读取真实配置，33 项浏览器夹具验证选择与拖放共用格式/去重/限制、有序原文及 DTD 字面保留、二进制/空白/超限不发请求、UTF-16/GBK、取消、自动创建可编辑导图、中英文提示与 375/1440px 无横向溢出；桌面上传提示与按钮保持同一行，测试接入既有 E2E runner。README 与手册同步实际扩展名及编码限制，生产构建通过，保留既有大型 chunk 提示。
- `node frontend/e2e/ai-generation.mjs`：独立接口夹具覆盖默认隐藏、后台只读与密钥保存、桌面/手机布局、Tab 循环、五份附件真实浏览器提取、PDF 超页拒绝、生成失败保留、错误树拒绝、保存重试不重复调用、取消后重开无旧写入、中英文，21 项通过。夹具不修改开发数据库。
- `pnpm test`：96 个测试文件、1361 项全部通过；`pnpm exec tsc --noEmit` 通过。PDF.js 本地 worker/字体资源在浏览器中实际提取、渲染通过。
- `dependency-loading.test.mjs` 在修复前证明缺少 PDF.js 预构建，修复后通过；独立临时 cacheDir 的全新 Vite 服务完成相同 21 项 E2E，无依赖发现导致的导航。`pnpm run build` 通过，PDF 模块仍为按需分块，既有大 chunk 警告不阻塞构建。
- 后台布局回归脚本保存后将鼠标移离通知区域，避免指针悬停使 Sonner 暂停消失并遮挡下一次保存；不修改通知或业务行为。`node frontend/e2e/admin-settings-layout.mjs` 中英文、桌面及手机布局 38 项通过。
- 拖放交互追加浏览器断言：文件进入/嵌套切换/离开高亮、文字原生拖动、多文件有序与去重、格式/数量/单文件大小超限保留已有项、生成中拦截及背景导入隔离、键盘上传；`node frontend/e2e/ai-generation.mjs` 31 项通过，桌面和手机截图已检查，`pnpm exec tsc --noEmit` 通过。
- 思考等级后端测试覆盖旧密文缺字段、全部枚举保存重载与空密钥保留、非法值不落库、默认请求字段不存在、显式 none 与其他等级原样发送、拒绝普通用户覆盖、公开配置不泄漏等级、Provider 拒绝后只调用一次且不改模型。相关 `go test ./internal/ai ./internal/settings ./internal/httpapi -run 'TestAI|TestConfiguration|TestGenerate|TestRejectsInvalid|TestSiteConfig|TestOpenAPI|TestAdminSettings' -count=1` 通过。
- 后台等级下拉覆盖旧响应缺字段、默认不传、键盘选择 max、保存刷新、全部枚举及重新清空、中英文与桌面/手机两列/单列；`node frontend/e2e/ai-generation.mjs` 43 项通过。`pnpm exec tsc --noEmit` 与附件、按需加载、i18n 守卫 13 项测试通过，后台截图已检查。
- 管理员配置的真实 Provider（保留原有 model）使用自行创建的 docx/xlsx/文字 PDF/扫描 PDF/PNG 完成联调，新建独立“AI联调测试”导图 11 节点，保留研发预算 1200 并自动进入编辑器。一次无效模型输出被拒绝，重试成功；不自动重试付费请求、不保存失败占位。已有三份开发导图未覆盖。

## Consequences

- 图片与扫描 PDF 依赖所选模型支持视觉；上下文与输出容量因 Provider 而异，限制内的请求仍可能被其拒绝。
- 思考等级枚举以官方 Chat Completions 契约为界，不代表每个模型均支持全部值；默认省略保持兼容，显式选择需管理员确认 Provider 和模型支持。后续官方扩展枚举时须同步后端校验、OpenAPI 与前端选项。
- 树契约隔离复杂文件格式，允许复用默认主题与普通创建权限；代价是生成与保存分两次请求。AI 输出是整理结果，可能遗漏或产生错误，用户需检查。
- 浏览器解析省去服务端 Office/PDF 运行组件，代价是按需下载 PDF.js 及本地资源、浏览器内存占用；带文字 PDF 中的内嵌图片当前不另传。扫描页不提供页内 OCR，由视觉模型理解页面图片。
- 无 BOM 时的 GB18030 回退是兼容策略，不是可靠的编码鉴定；其他旧编码或恰巧可解码的损坏内容仍可能被误识别，必要时另存 UTF-8。文本上限适用于生成要求与全部材料合计，不能把 20 MiB 文件上限误解为可发送 20 MiB 正文。
- 配置按请求读库，在配置与生成频率下省去跨实例缓存失效机制；代价是公开配置请求也增加一次设置表读取。如果设置表规模增长，应增加按键仓储读取，不应缓存紧急关闭开关。
- 并发与频率限制按实例生效；多实例部署如需严格全局成本配额，应迁移到共享限流器。
- 现有导图创建 API 不具备跨网络重试幂等性；前端防重复和分阶段重试覆盖正常交互，连接在保存成功后丢失仍可能让用户需要回列表确认。
- README、使用手册与环境配置示例说明入口、发送范围、格式限制、只读末尾提示词以及有效加密密钥稳定性，避免把 AI 密钥当成浏览器端配置或认为旧 Office 格式可直接读取。使用手册补充拖放与思考等级；数据模型和 API 文档同步默认省略、合法枚举及管理员控制边界，OpenAPI 为网络契约依据。
