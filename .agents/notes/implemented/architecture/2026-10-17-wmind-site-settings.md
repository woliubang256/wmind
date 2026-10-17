# Agent Note: 站点设置：schema 注册表 + 不可变快照 + 白名单公开

Status: implemented

## Problem

M1-4 要让「关掉注册」这件事在运行时生效：`POST /auth/register` 必须立刻返回 403 `REGISTRATION_CLOSED`，而不是重启后才生效。围绕这一点有四个必须先定下来的问题：

- 20 个设置项的**类型、默认值、校验规则**放在哪，才能既不散落在 handler 里，又不用为每个键写一个 Go 类型？
- 读路径在认证热路径上（每次注册都要读两个值），怎么避免每次打库？
- `PUT /admin/settings` 是部分更新，遇到未知键 / 类型不符 / 越界时怎么报错才让管理员一次改完？
- `GET /site/config` 是未登录可访问的，公开哪些键由谁决定？

## Decision

### 一份 schema 注册表就是唯一事实来源

`internal/settings/schema.go` 里 `specs []Spec` 描述了全部 20 个键：`Kind`（string / bool / int）、`Default`（**JSON 文本**）、`Public`、`Min/Max`、`MaxRunes`、`Enum`。

- 默认值写成 JSON 文本（`"wmind"` / `true` / `8`）而不是 Go 字面量，是为了让「库里的值」与「默认值」走**同一条解析路径**（`parseStored`）。否则默认值那条路没有校验，schema 里写错一个默认值要到线上才暴露。
- 值在库里统一存成一段 JSON 文本（`settings.value`），所以**新增设置项不需要改仓储、也不需要改两套迁移**。代价是 SQL 里没法对设置值做类型运算——而设置本来也不需要被 SQL 查询。
- 类型收敛（`json.Number` / `int` / `float64` → `int64`）只写在 `toInt64` 一处。`1.5` 被拒绝而不是截断成 `1`：静默截断会让管理员以为设置生效了。

### 快照不可变，读路径无锁

`Service.current` 是 `atomic.Value`，装的是 `*Snapshot`。`Snapshot.values` 是私有 map，对外只暴露 `String/Bool/Int` 与语义化访问器（`SiteName()` / `RegistrationEnabled()` / `PasswordMinLength()`…），返回后调用方拿不到可写引用。

这带来两个直接结果：
- 读路径没有锁，也不会有「读到一半被改掉」的撕裂读——并发读者拿到的一定是同一个自洽版本。
- `Service` 自身实现 `service.SiteConfigProvider`（而不是把某一份 Snapshot 传进去）。这是关键：`AuthService` 每次注册都读**当前**快照，所以管理员关掉注册后，**下一个请求**就返回 403。

### 校验全部前置，一次报全字段错误

`Update` 先把 patch 里每个键校验完（收集所有 `fields`），任何一个非法就整体拒绝，一个键都不写。理由：一半写进去、一半失败会让设置处于自相矛盾的状态（「关掉注册」成功但「改密码长度」失败），而管理员看到 422 会以为整次修改都没生效。

写入本身包在一个事务里（`TxManager.WithTx`），所以「写到第三个键时数据库报错」不会留下前两个。

### 写入后重载；读不回来就用「旧快照 + 本次改动」

正常路径是写完后 `Reload` 全量重读。如果重读失败（库抖动），内存里保留的是合并后的快照（`merge`），保证接口响应与刚写进库的内容一致；下一次 TTL 刷新会修正。不用「写成功就假定读一定成功」——那样一次库抖动会让接口返回旧值而库是新值，排查起来极其费劲。

### 未知键与损坏值都降级，不阻断

`Reload` 遇到 schema 之外的键只打 WARN 跳过（降级运行的残留）；遇到解析不了的值退回该项默认值并打 ERROR，其余键照常生效。站点不能因为一个设置项坏了就起不来，也不能因为一次降级就起不来。

### 公开配置是白名单，不是黑名单

`GET /site/config` 的响应体是一个**显式列字段的 struct**，不是「把快照 map 过滤一下」。理由：这个接口未登录可访问，漏掉一个敏感键就是把内部策略（锁定阈值、上传上限）印在登录页上。加字段必须手写一行，这个摩擦是有意的。

`Snapshot.Public()` 另有一套 `Public` 标记供未来的分享页复用；两处都保留是因为它们服务的对象不同——前者是「HTTP 契约」，后者是「快照的公开子集」。

## Alternatives considered

- **每个设置项一个 Go 结构体字段 + `mapstructure`** — 类型最强。被否是因为新增一个键要改结构体、默认值、校验、序列化四处，而设置项是最容易增删的东西。
- **每次读都打库** — 最简单、多实例天然一致。被否是因为注册路径每次都要读两个值，把认证接口的延迟绑在数据库上；而设置是典型的「读极多、写极少」。
- **读的时候检查 TTL 是否过期** — 省掉后台 goroutine。被否是因为它把一次同步的库读塞进任意请求的延迟里，而且并发请求会同时发现过期、同时去打库。
- **PUT 时逐键写、遇错就停（不回滚）** — 少一层事务。被否是因为设置项之间有语义耦合（`auth.registration_enabled` 与 `auth.default_role`），半改状态会造出「谁都能注册成管理员」这种意外组合。
- **未知键静默忽略** — 对前端更宽容。被否是因为拼错键名（`site.nmae`）会静默无效，管理员会以为设置生效了；`SETTINGS_INVALID` 才让人发现。
- **`GET /site/config` 直接返回快照的公开子集 map** — 少写一个 struct。被否同上：白名单要显式到字段级。
- **`auth.default_role` 允许设为 `admin` 但不消费它** — 避免「开放注册 + 默认管理员」的风险组合。被否是因为不消费的设置项等于假的：管理员改了没效果，比拒绝更糟。改为**照实消费 + 启动时 WARN**。

## Consequences

- **收益**：关掉注册立刻生效（验收标准 1），无需重启；设置改动对公开配置与认证流程同时生效。
- **收益**：新增设置项只改 `schema.go` 一处（外加前端表单），不碰仓储与迁移。
- **收益**：`1.5` 不会被静默截断成 `1`，拼错的键名会报错。
- **代价**：设置值在库里是 JSON 文本，`SELECT` 出来不能直接比较大小/真假。这是为「不改仓储加键」付的价。
- **代价**：`auth.default_role = admin` + 开放注册 = 任何人都能注册成管理员。这是文档允许的配置，服务端只在启动日志里 WARN，不做拦截。
- **代价**：多实例下 `PUT` 只刷新本实例，其它实例最多滞后 60 秒（`DefaultTTL`）。对「改站点名」可接受，对「紧急关闭注册」不够——真要即时，得加 Redis Pub/Sub，接口已留好替换点（`Reload`）。
- **已知差异**：`GET /site/config` 比 docs/04 §5.1 的示例多一个 `shareEnabled` 字段（docs/03 §4.2 要求 `share.public_link_enabled` 公开）。M1-7 文档同步时要补上。

## Verification

- `go test ./internal/settings/...`：默认值在 Load 之前可用；Update 落库形式是 JSON 文本且立刻生效；8 类非法输入（未知键 / 类型不符 / 小数 / 越界 / 空串 / 超长 / 枚举外 / 字符串给数字）都返回 `SETTINGS_INVALID` 且一个键都没写；多个非法键一次报全；写失败整体回滚；空 patch 不写库；未知键与损坏值降级；`Public()` 排除敏感项；`All()` 与 schema 双向一致；`Reload` 能看到外部改动；`Run` 在 ctx 取消后退出。
- `go test ./internal/httpapi/...`：`/site/config` 未登录 200 且不含敏感字段；`/admin/settings` 未登录 401、普通用户 403（读与写各验一次）、管理员 200；改设置后公开配置立刻变化、注册返回 403 `REGISTRATION_CLOSED`、重新打开后注册恢复 201；4 类非法 patch 返回 422 且带 `details.fields`；数组请求体返回 400。
- 生产二进制冒烟：`GET /site/config` 返回 20 项中的 11 项公开值；`PUT /admin/settings` 关闭注册后 `POST /auth/register` 立即 403 `REGISTRATION_CLOSED`；非法 patch 返回 422 并指明两个字段。
