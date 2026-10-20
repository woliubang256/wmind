# Agent Note: 模板选择与模板管理

Status: implemented

## Problem

M5 剩下两块之一：新建导图时选一个起点，以及把现有导图存成自己的起点。

数据库侧不需要迁移——`templates` 表从 M1 就在（`uid` / `owner_id` 可空 /
`is_builtin` / `sort_order` / `document` 全是照设计稿建的），但**从查询到界面
一行都没有**：没有 `templates.sql`、没有 domain 类型、没有仓储、没有 service、
没有 handler，`/templates` 是一个 `PlaceholderPage`。

真正的设计问题是：**那 8 个内置模板放哪儿**。

## Decision

### 内置模板编译进前端包，不进数据库

`frontend/src/features/templates/builtin.ts` 里 8 个定义，每个给出结构、配色、
以及一棵用文案键描述的骨架；`buildTemplateDocument` 用 `createDocument` /
`createTopic` 把它们构造成完整文档。`templates` 表只放用户模板。

三条理由，第一条是决定性的：

1. **选择对话框要渲染实时预览**。预览需要文档，所以文档必须在请求回来之前
   就存在。从服务端取意味着对话框先白一下再出图，而 8 份文档加起来不过几 KB。
2. **模板名是 i18n 键**。一个 TEXT 列存不下一份在 zh-CN 与 en-US 里都成立的
   文案；内置模板要是落在表里，英文用户永远看到「思维导图」。
3. **骨架由文档模型的构造器生成**。文档模型新增一个必填字段时，`createTopic`
   自动补上；而仓库里躺着的 8 份 JSON 会静默变成非法骨架，直到有人打开那个
   模板才发现。

这与 10 套内置配色的处理是同一个决定（ADR-019），理由几乎是逐条对应的。
`is_builtin` 与可空的 `owner_id` 保留为二期「管理员维护内置模板」的钩子。

### 读路径认内置行，写路径不认

`ListTemplatesByOwner` / `GetTemplateByUID` 的条件是
`owner_id = ? OR owner_id IS NULL`。今天的库里不会有 `owner_id IS NULL` 的行，
但少了这个 `OR`，`TEMPLATE_BUILTIN_READONLY` 就永远打不出来：内置行对所有人
都「不存在」，于是「不可改名 / 不可删除」的守卫是一段死代码。将来真有人往表里
种内置模板时，它也是不可读的。

写路径（`RenameTemplate` / `DeleteTemplate`）保持 `owner_id = ? AND is_builtin
= false`，所以内置行永远改不动。

### 列表不带文档

`ListTemplatesByOwner` 显式列出列名并**跳过 `document`**。一份文档的上限与
导图一样是 8 MiB，50 个模板就是 400 MB 的列表响应。列表只需要名字、结构、
缩略图；真要用某个模板建图时，`GET /templates/{uid}` 单独取一次，一次点击
一次请求。

### 缩略图来自源导图，不来自请求

`thumbnail_url` 在「另存为模板」时从源导图复制。让客户端传这个字段等于把模板
列表变成一个图片代理——卡片会照着调用方给的 URL 去加载任意地址。

### 结构从文档里读，读不到就兜底

`templateStructure` 用一个小信封结构只解 `sheets[0].structure`，不把整份文档
反序列化成强类型。缺失或空白一律兜底成 `mindmap`，而不是报错：结构缺失的文档
仍然是一份能打开的文档（前端会归一化），为它拒绝「另存为模板」只会让用户对着
一个说不清原因的错误。

### 示例文案用共享词表

8 个模板各写 10 句产品文案既翻不好，也会在用户改第一个字的时候消失。改成
`templates.sample.*` 一套共享词表（主题 / 分支 N / 要点 N / 部门 N / 阶段 N …），
每个模板用不同的子集与配色区分。模板的价值在于「这一层该放什么」，不在文案本身。

### 其余几处

- `feature.user_template_enabled = false` 时 list / create / rename / delete
  全部 403 `TEMPLATE_DISABLED`，内置模板不受影响——它们不经过服务端。
- 前端新增两个错误码：`TEMPLATE_LIMIT_REACHED`（403）、`TEMPLATE_DISABLED`（403）。
- 「从模板建图」抽成 `useTemplateCreate`：选择对话框与模板页都要做，而它有
  三处容易分叉的细节（归一化文档、改写标题与时间戳、建完跳转）。
- 建图前会把文档的 `title` 与 `meta` 时间戳改写成「现在」。不改的话，从模板
  建出来的图导出时文件名会叫成源导图。
- `features/dashboard/pages.tsx` 删掉了：它只剩「模板」一个占位，而模板页
  已经真做出来了。留着就是两份代码里的一份永远不生效。

## Consequences

- 后端新增 6 条查询、`domain.TemplateRepo`（6 个方法）、双方言仓储、
  `TemplateService`、`TemplateHandler`、5 条路由（全在 `RequireAuth` 之下）。
- 测试：service 10 条（另存为复制文档、结构兜底、名字校验、跨用户、上限、
  站点开关、列表不带文档、改名删除、内置只读、结构解析 6 种输入）、HTTP 5 条
  （鉴权、生命周期、跨用户隔离、校验、站点开关）、仓储契约新增一条跨双方言
  子测试（含 `16777217` 精度、列表不带文档、跨用户 `ErrNotFound`）。
- 前端 `builtin.test.ts` 29 条：8 个模板各能过 `parseDocument`、结构在前端支持
  范围内、至少三层、文案键在中英两种语言里都存在、`{{n}}` 被真实替换、两次
  构造的 id 不共用、`asStructureClass` 的兜底。
- 界面验收 27 条（`/tmp/wmind-accept/f-templates.mjs`）：8 个模板各建一次且
  结构逐一匹配、预览真的画出了 SVG（90 个 text 节点）、分类与搜索、另存为模板、
  模板页列出两段、改名、用我的模板建图、删除、站点开关的四个面。
- 打包新增 `templates` 相关代码，但没有独立 chunk——它随 `index` 走，因为
  首页的「新建」按钮直接引用了选择对话框，动态 import 反而多一次往返。
- 已知缺口：内置模板的预览是 8 个 `MindMapViewer` 同时挂载。8 张 10 节点的图
  在桌面端没问题，低端移动端打开对话框会有一帧卡顿；真要优化，应该是「只渲染
  视口内的卡片」，而不是把预览换成截图。

## Alternatives considered

**内置模板进数据库、启动时从嵌入的 JSON 种一遍**：与 `docs/04` §5.4 的原始
设计一致，也让自建者能改模板。放弃原因见「Decision」的三条——预览、i18n、
模型同步，任何一条单独都不足以否决，三条加起来就很重。真需要可编辑的内置模板
时，`is_builtin` 与可空 `owner_id` 已经把路留好了。

**列表也带 `document`，前端自己做预览**：省掉一次单条请求。放弃原因是列表响应
的体积没有上界——50 个模板、每个都可能接近 8 MiB。上限不是靠「用户不会那么做」
来保证的。

**用 `renderThumbnailPng` 给内置模板预生成 PNG 存进包**：卡片更轻。放弃原因是
改一次骨架就要重出一遍图，而这张图还会和「用这个模板建出来的图」慢慢漂移。
实时渲染永远不会不一致。

**每个模板一套专属示例文案**：更像成品。放弃原因是 80 条需要翻译的字符串，
而且用户改第一个字就抹掉了——投入产出比明显不划算。

**「新建」直接建空白导图，模板入口单独放**：改动最小。放弃原因是模板的价值
就在「新建」这一步；放到别处等于让它变成没人点的功能。空白导图的出口保留在
对话框底部一行 ghost 按钮上。
