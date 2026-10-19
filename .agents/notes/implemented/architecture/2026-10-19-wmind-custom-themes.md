# Agent Note: 自定义主题：后端 CRUD、读路径兜底与「我的主题」面板

Status: implemented

## Problem

M3 的最后一项交付是「用户保存 / 复用自定义主题」。开工时 [04 §5.5](../../../../docs/04-后端设计与API规范.md) 写的是 `GET /api/v1/themes` 返回「全部内置主题 + 当前用户自定义主题」，也就是 10 套内置配色也要进 `themes` 表。落地时发现几件事必须先定：

- **内置配色到底存在哪？** 表里一份、包里一份就是两份事实来源。
- **一条自定义主题存什么？** 6 个颜色的 `Palette`，还是整份 `Theme`？
- **存下来的 `config.id` 是谁的 id？** 客户端发上来的通常是「当前画布的主题」，它的 `id` 往往还是某个内置配色的 id。
- **读路径怎么容错？** 库里那份 JSON 可能来自更早的前端版本：缺字段、多字段。少一个 `palette.colors` 就会让 `resolveStyle` 撞上 `undefined`，整张图变白且不报错。
- **演示文档怎么办？** `/maps/demo` 与 `/maps/stress` 不连后端，面板在那里发一次请求就会 401。

## Decision

### 内置配色不进表（ADR-017）

10 套配色只存在于 `frontend/src/editor/theme/palettes.json`。编辑器首帧就要用 `resolveStyle` 给每个节点算填充与字色，等一个请求回来意味着「先白一帧再上色」，离线打开则完全不可用。若表里再种一份，服务端的 `config` 还得用 Go 重写 `themeFromPalette` 的装配逻辑——那是把前端样式体系抄进后端，此后每加一个样式字段都要两边同步，还要额外维护一道一致性闸门。

`themes` 表因此只放用户主题：`owner_id` 恒非空、`is_builtin` 恒为 false。字段与 `THEME_BUILTIN_READONLY` 错误码保留，作为二期「管理员维护内置主题」的口子。

### 存整份 `Theme`，不存 `Palette`

用户点「保存为我的主题」的意图是「记住现在这个样子」。只存 6 个颜色会丢掉全局字体字号、背景色、彩虹开关与三个布局开关，保存出来的主题和应用出来的效果差一截——比不能保存更让人困惑。

### `config` 的身份三件套由服务端改写

`normalizeThemeConfig` 把 `id` 改成该主题的 `uid`、`name` 改成主题名、`category` 改成 `custom`。不改的话，一份自定义主题会顶着 `classic-rainbow` 的 id 出现在列表里，而面板的「当前选中」判断正是 `theme.id === palette.id`——点一下自定义主题会把内置那套点亮。

实现上用 `map[string]json.RawMessage` 承接而不是结构体：未知字段必须原样留住，否则「前端给 `Theme` 加一个字段 → 用户存一次主题 → 字段被后端吃掉」是静默的数据丢失。

### 体检只做「没有它就不是主题」的字段

`palette.colors` 非空、所有颜色是 `#RRGGBB`、`global.fontFamily` 非空、`fontSize > 0`、`config ≤ 64 KiB`、`name` 去空白后 1~64 字。其余字段一概不解析——样式体系归前端所有。

`#RRGGBB` 只收六位完整写法：三位简写会让对比度校验脚本与运行时解析器产生两种理解，`rgba()` 在 SVG 导出里不一定被支持。

### 读路径以默认主题为底稿逐字段补齐

`themeFromCustomConfig`（`editor/theme/custom.ts`）不是简单的 `{...base, ...config}`：

- `{...base, ...config}` 在 `config` 里某个键显式是 `undefined` 时会把底稿覆盖成 `undefined`；所以七个角色样式逐个判断 `value === undefined ? base[key] : value`。
- `config.summaryTopic === null` 必须**保留 null**：解析链里 `null` 是有效值（「这个角色确实没有样式」），与「没存过」不是一回事。
- `layout` 只覆盖存过的键（旧版本前端没有 `alignSiblings`），其余取 `DEFAULT_LAYOUT`。
- `rainbowColors` 缺失时取调色板颜色，**不是空数组**——空数组会让彩虹开关打开后所有分支都退化成同一个颜色，看起来像开关坏了。

### 写路径直接发当前 `theme`

不需要对应的序列化函数：服务端会做同样的规范化。少一层转换就少一处「本地以为存的是 A、实际存的是 B」。

### 演示文档不发请求

`useCustomThemes(enabled)` 的 `enabled` 直接接 `Workspace` 的 `enabled`（本地文档为 false）。演示页里发一次 `GET /themes` 会拿 401，401 触发静默刷新，刷新再失败就跳登录页——点开演示却要求登录，是最容易被当成「坏了」的 bug。面板在 `canPersist === false` 时只显示一句说明。

### 卡片用两个并排按钮，不是「卡片里嵌一个 ×」

按钮里套按钮是非法 HTML，浏览器会把内层拆出去，键盘用户会发现「删除」不在 Tab 顺序里。改成 `flex` 容器里两个兄弟按钮：左边应用、右边删除，各自可聚焦。

名字那行显式写 `leading-4`：`truncate` 带 `overflow: hidden`，配上继承来的紧凑行高，中文字形的上下缘会被切掉一截（第一版截图里就是这样，靠 `getBoundingClientRect` 才确认不是错觉）。

## Consequences

- 新增 4 个接口（`GET/POST /themes`、`PUT/DELETE /themes/{uid}`），错误码新增 `THEME_LIMIT_REACHED`（403，上限 50 条/人）。
- **没有新增迁移**：`themes` 表在 0001 初始化迁移里已经存在，列与索引都够用。
- 服务端多了一次「先读再写」：`Update`/`Delete` 先 `GetByUID` 再判断 `IsBuiltin`。仓储的 SQL 带 `is_builtin = false` 谓词，命中 0 行只能返回 `ErrNotFound`——那样「改内置主题」会被报成「主题不存在」。多一次往返换来准确的错误码，对低频操作划算。
- 主题是「主题的容器」：导图文档里仍然只存 `theme` 本身，**不引用 `themeUid`**。引用会让「删掉主题」把存量导图的颜色一起带走。
- `Makefile` 的 `sqlc` 目标原先写的是 `cd backend && sqlc generate`，而 `sqlc.yaml` 在 `backend/db/` 下——sqlc 不向上递归，这条命令一直是坏的（CI 里用的是正确路径）。本次顺手改成 `cd backend/db`。
- 保存主题不做「同名去重」：同名主题是合法的（用户可能想保留两版配色对比），靠 `uid` 区分。删掉其中一条不影响另一条。
- `docs/04 §5.5`、`docs/04 §6` 错误码表、`docs/09` ADR-017 已同步。

## Alternatives considered

- **按原设计把内置配色种进 `themes` 表**：接口语义最统一，但首帧要等请求、样式装配逻辑要抄进 Go、还要维护一份镜像的一致性。
- **内置配色进表，前端仍用包内那份，表只作镜像**：接口语义满足文档，可镜像表永远没人读，却要维护播种迁移与校验——纯粹的装饰性数据。
- **存 `Palette`（6 色）而不是整份 `Theme`**：表更小、与内置配色同构，但用户保存的意图是「记住现在这个样子」。
- **客户端负责改写 `config.id`**：少一次服务端改写，但「谁能改这个字段」变成前端自觉，第二条写入路径（未来的导入 / 模板）就会漏。
- **读路径直接信任库里的 JSON**：省掉 `themeFromCustomConfig`，代价是任何一次样式字段重命名都会让存量主题整份失效，而且失败是静默的。
- **主题列表分页**：上限 50 条、每条几 KB，分页只会制造一个「第二页永远为空」的假接口。仍然走 `response.List` 信封，前端复用 `apiList`。
