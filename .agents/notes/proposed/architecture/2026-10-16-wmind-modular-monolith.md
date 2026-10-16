# Agent Note: wmind 采用模块化单体与单向分层

Status: proposed

## Problem

wmind 要从零实现一套可私有化部署的思维导图系统：后端 Go、前端 React、Docker Compose 部署，需求覆盖账号体系、导图编辑器、模板、主题、导入导出、管理后台。

在写第一行代码前必须钉死三件事：服务怎么切分、模块之间的依赖方向、部署形态。不先钉死，后续每个功能都会自行决定「这段逻辑放哪」——handler 直连数据库、格式转换逻辑散落在 HTTP 层、或者为了「以后好扩展」提前拆服务，最后付出的是部署复杂度而非扩展性。

## Proposal

**服务切分：单个 Go 二进制承载全部业务模块。** 模块间通过 Go 接口通信，不通过网络。用户、导图、模板、主题、设置共享同一数据库事务。

**依赖方向：`httpapi → handler → service → repository/convert/storage`，单向。** `domain` 与 `docmodel` 被所有层依赖但不依赖任何层。

三条硬性约束（ESLint / code review 检查）：

1. handler 层禁止 import repository —— 防止业务逻辑绕过 service 直接落库。
2. service 层禁止 import gin —— 保证业务逻辑可脱离 HTTP 单测。
3. repository 禁止 import service —— 防循环依赖。

**装配：不使用 DI 框架。** `cmd/server/main.go` 手工装配全部依赖。模块数量 < 20 时手工装配可读性最好，且无运行时反射。

**部署形态：三个容器（web/nginx + api/go + db/postgres），仅 web 暴露宿主机端口。** 目标是 `docker compose up -d` 一条命令完成部署，除 PostgreSQL 外无外部强依赖。

## Alternatives considered

### 为什么不用微服务？

微服务能独立扩缩容、独立部署，对「某模块成为瓶颈」的场景确实是正解。但本项目的核心产品卖点是「一条命令部署」，微服务会直接破坏它；用户/导图/模板共享同一事务，拆分会引入分布式事务；当前业务规模与团队规模也不支持微服务的运维成本。若未来某模块（如导出渲染）真成瓶颈，因为模块边界已由 Go 接口定义，可以单独抽出而不改调用方——先不做，但留好了抽出的缝。

### 为什么不用完整 DI 框架（wire / fx）？

`google/wire` 提供编译期依赖图校验，`uber/fx` 提供运行时生命周期管理。两者在大型项目里有实际价值。未选的原因是本项目依赖图是浅的线性结构（约 20 个构造函数），手工装配一目了然，且新人阅读 `main.go` 就能看懂全局；引入生成步骤或运行时容器属于为不存在的复杂度付费。

### 为什么不把 npm 脚本与前端工程合并到根目录？

根目录已有 `.agents/skills/` 的 TypeScript 校验脚本，需要 `package.json` 才能跑 `npm run verify-notes`。可选方案是新建根 `package.json` 只承载工具链，或把脚本挂到 `frontend/package.json`。倾向于前者，但涉及「根目录出现 Node 工程是否会让 Go 项目看起来像 monorepo」的取舍，留到 M0 实现时定。

## Acceptance criteria

1. `docker compose up -d` 后访问宿主机端口可见前端页面，`/api/v1/health/ready` 返回 200。
2. 任意 handler 文件中不出现 repository 包的 import；任意 service 文件中不出现 gin 的 import（由 lint 规则或 review 保证）。
3. 新增一个业务模块时，只需在 `main.go` 增加装配代码，不需要改动其他模块。
4. 本地开发模式（前端 `pnpm dev` + 后端本地启动 + 仅 db 用容器）可正常联调。

## Risks

- **单体的隐性耦合**：模块边界靠约定而非物理隔离，随着规模增长可能被侵蚀。缓解：依赖方向写进文档与 review checklist，必要时用 lint 规则强制。
- **水平扩展受限**：限流用内存实现，多副本时会各自计数。已把 `Limiter` 抽象为接口，切 Redis 实现即可，但一期不做。
- **`main.go` 装配膨胀**：模块数超过约 30 个后手工装配会变冗长。届时再评估引入 `wire`。
