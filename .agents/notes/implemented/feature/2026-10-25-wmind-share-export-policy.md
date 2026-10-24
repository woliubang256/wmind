# Agent Note: 分享图形导出固定品牌与 JPEG 默认格式

Status: implemented

## Problem

分享访客目前能关闭或改写导出品牌，外部传播的图形不再能表达站点来源。编辑者仍需要给不同客户定制落款，不能把分享限制扩大到内部。两处导出入口目前默认 SVG，用户要求都默认 JPEG。

## Decision

`DEFAULT_EXPORT_OPTIONS.format` 使用 JPEG。`ExportDialog` 接收默认关闭的 `brandLocked`，分享入口打开；在构建预览、整图导出与分支拆分上下文前统一解析有效选项，锁定时强制启用站点品牌，空品牌回退站点名，最终兜底 wmind。分享不渲染品牌开关或文字字段。

站点配置异步到达时按最新配置解析，分享配置尚在加载时不允许图形下载。内部保留用户改过就不再覆盖的预填逻辑。Markdown、OPML、XMind 是结构化内容，不增添水印节点或文本。固定品牌仍走共享 SVG 页脚，并进入 `paintedRuns`、缺字检测和 `planFamilies`，不维护第二套水印渲染。

## Existing note audit

- [品牌站点设置](../../implemented/architecture/2026-10-23-wmind-brand-setting.md)：部分重叠，双向互链。内部可覆写的原理由保留，分享的例外由本篇约束。
- [SVG 框架](../../implemented/architecture/2026-10-20-wmind-export-svg.md)：部分重叠，保留共享渲染与预览即成品的决定。
- [文本导出](../../implemented/architecture/2026-10-20-wmind-export-text.md)：无冲突，品牌不适用于文本格式的边界保留。
- [字体回退](../../implemented/architecture/2026-10-21-wmind-font-fallback-detection.md)：部分重叠，强制品牌继续经过 paintedRuns 与字体计划，不另画水印。

## Alternatives considered

- 仅隐藏分享控件：代码改动最少，也能减少界面杂项；但旧选项和分支拆分仍可能关闭落款，不能满足强制品牌。
- 全站锁定品牌：所有入口一致，维护分支更少；但内部为客户定制落款的既有需求仍成立，限制只应施加给分享访客。

## Testing

`export-policy.test.ts` 先失败复现 SVG 默认值及缺失锁定策略，再验证 JPEG 默认、编辑端不覆盖、四种图形锁定、字体计划、配置变化、文档格式隔离与拆分品牌。原有透明 SVG 用例显式指定格式，避免误把新的 JPEG 不透明语义当回归。

`e2e/export-policy.mjs` 全部 API 使用夹具，不写真实数据。覆盖编辑端自定义和关闭品牌、配置迟到、重新打开默认 JPEG、分享品牌控件不存在、配置未到不可下载、SVG 成品内嵌字体、PNG/JPEG/PDF 实际页脚品牌像素、多画布成品、四种格式每个拆分文件带品牌，以及空品牌回退站点名称。文本/XMind 预览保持不含品牌。

已通过导出目录 207 项单测、浏览器 34 项、TypeScript 和笔记门禁；浏览器用独立本地 Vite 5302，未访问线上或写入真实业务数据。

## Consequences

分享导出获得统一且不可通过产品选项移除的来源落款，编辑者仍能定制。默认 JPEG 更适合直接传播，但不支持透明；已有白底提示与其他格式选择保留。维护成本是新增显式分享策略参数和一个统一有效选项入口，拆分调用也必须使用该入口的结果。

纯前端导出无法阻止拿到文档的访客在站外自行制图；约束面是产品提供的导出入口，不是 DRM。配置加载期间分享图形下载暂不可用；加载失败沿用站点配置的现有 wmind 兜底。
