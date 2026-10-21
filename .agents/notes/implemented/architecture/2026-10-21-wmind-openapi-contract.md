# Agent Note: OpenAPI 契约与路由表对等

Status: implemented

## Problem

`docs/04` §5 用散文加 JSON 样例描述了 49 个接口，但它没法被工具消费：想生成
客户端、想导入 Postman、想拿它做契约测试，都得先手抄一遍。而手抄的那份一定会
和散文慢慢分家。

更麻烦的是**散文本身也会过期**。加一条接口、删一条接口，`docs/04` 不会因此报错，
只会在某天有人照着它写客户端时才发现——那时离改动已经过去几个星期。这个仓库
里已经有过一次：docs/README 的索引行写着「50 个接口定义」，而 docs/04 §5.10 的
合计栏写着 49，两者矛盾了很久没人发现。

## Decision

写一份机器可读的 `docs/openapi.yaml`（OpenAPI 3.1），**并用两条 Go 测试把它钉在
路由表上**。

### 两条测试分别管什么

`TestOpenAPIMatchesRouter` 拿 `engine.Routes()` 做双向比对：

- 路由表里有、yaml 里没有 → 报「加接口忘了写文档」；
- yaml 里有、路由表里没有 → 报「删接口忘了删文档」；
- 另外断言每个 path 都在 `/api/v1` 下、不带查询串，并且操作总数等于
  `apiOperationCount`（49）。

那个常量是刻意的摩擦：真加了一个接口，改它的时候手会停一下，多半就会顺手去
更新 `docs/04` §5 与 yaml。

`TestOpenAPIReferencesResolve` 走一遍 YAML 节点树，把每个 `$ref` 拿去和
`components` 里真实存在的条目对账。拼错一个字母在 YAML 里完全合法，只有真正
生成代码或渲染文档时才会炸。

### 三处不显然的地方

1. **`description: **不含**属主的 uid 与邮箱。` 让整个文件解析失败**，报
   `yaml: line 1627: did not find expected alphabetic or numeric character`。
   YAML 里裸标量的第一个字符若是 `*`，会被当成别名节点（alias），`*不含**` 自然
   不是合法锚点名。这条错误信息指向的行号是对的，但「did not find expected
   alphabetic or numeric character」完全没提别名——第一反应会去查 `type: [string,
   'null']` 那类流式序列。改成「刻意不含」，加粗在这里本来也不重要。
2. **gin 的 `:uid` 与 OpenAPI 的 `{uid}` 不是一套语法**。直接比对时，21 条带参数
   的接口会**同时**报「缺一条、多一条」，噪声把真正的差异全淹了。加一个
   `ginPathToOpenAPI` 把 `:param` / `*param` 转成 `{param}`，差异立刻归零。
3. **静态文件路由不算 API**。`/uploads/*filepath` 由静态中间件直接回文件，不进
   信封、不参与版本化，所以 `notAPI` 把它排除在外——这也是「50 vs 49」的来源：
   把 `/uploads` 或只有设计没路由的 `POST /export` 算进去才会得到 50。

### 与散文的分工

`openapi.yaml` 是**形状**（路径、方法、字段、状态码、错误码枚举），`docs/04` §5
是**理由**（为什么列表不带 `document`、为什么关站判定排在限流器之前、为什么
`share.require_password` 不公开）。两份都要改，但改的理由不同，所以没有把散文
塞进 `description`——那会让 yaml 变成第二个散文库。

## Consequences

- 接口漂移从「某天被发现」变成「`go test ./...` 变红」。
- `docs/04` §5 开头加了指引：改接口时 `router.go` / §5 / `openapi.yaml` 三处一起改。
- docs/README 的索引行从「50 个接口定义」改成「49 个已注册接口定义」，并新增
  `openapi.yaml` 一行；阅读路径里的「只关心后端」也带上它。
- **没有引入新依赖**：解析 yaml 用的是 `go.yaml.in/yaml/v3`，它本来就在依赖图里
  （viper 带进来的），只是从 `// indirect` 挪到直接依赖。`go mod tidy` 顺带把
  `golang.org/x/image` 也扶正了——`internal/imageproc` 一直在 import 它，却被标成
  `// indirect`，是个早就该修的标注错误。`go.sum` 一行没变。
- 本地用 `@apidevtools/swagger-parser` 跑过一次全量校验（`VALID 3.1.0 34 paths`）。
  **这是本地一次性检查，没有进仓库依赖**——CI 里兜底的还是那两条 Go 测试，
  它们不校验 JSON Schema 语义，只校验对等性与引用完整性。
- `apiOperationCount` 会随接口增减而变，这是设计意图，不是需要消除的维护成本。

## Alternatives considered

- **从代码生成（`swaggo/swag` 注释扫描）**：注解写在 handler 上方，和实现挨得近，
  不容易分家。但生成物会覆盖人手写的 `description`，而那些「为什么」恰恰是这份
  文档最有价值的部分；而且注解是注释，编译器不管，拼错了照样静默。改成「手写
  yaml + 测试比对」，把校验放在 CI 里而不是放在生成器里。
- **只用散文（现状）**：无法被工具消费，且已经证明会过期。
- **只用 yaml、删掉 docs/04 §5**：会丢掉全部设计理由，而 `docs/04` 是评审基线。
- **在测试里做完整 OpenAPI 校验（JSON Schema 语义）**：需要引入一个 JS 工具链
  或一个 Go 侧的完整校验器（`kin-openapi` 对 3.1 支持不完整）。收益是能抓住
  「`required` 里的字段在 `properties` 里不存在」这类错，但那类错在写的时候
  基本不会犯；对等性与引用完整性才是真会悄悄坏的两处。
- **把 e2e 的请求录制下来反向生成 spec**：能保证「至少覆盖到的接口」是对的，
  但覆盖不到的就是空白，而且生成出来的字段形状来自某一次真实响应，会把
  `null` 与「字段缺失」混为一谈。
