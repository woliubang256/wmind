# Agent Note: M0 工具链基线：Go 1.25 + Gin v1.12，笔记校验脚本零依赖运行

Status: implemented

## Problem

M0 要在写业务代码之前把工具链定死：Go 版本、Web 框架版本，以及「非平凡改动必带笔记」这条流程在一个**根目录没有 Node 工程**的仓库里怎么落地。

设计文档里写的是 Go 1.23 + Gin v1.10。那是写文档时的已知版本，不是约束。真正 `go mod tidy` 时会发现版本下限由传递依赖决定——必须量出来再定，否则 CI 与 Dockerfile 会各写一套版本号，而两处不一致的症状是「本地能构建、镜像构建失败」。

笔记校验脚本则卡在另一件事上：本机 npm 缓存目录权限异常，`npx tsx` 装不上。

## Decision

Go 版本与基础镜像约束由[安全工具链基线](2026-10-26-wmind-security-toolchain-baseline.md)部分取代。下文 Go 1.25 段落保留 M0 的选型理由；现行安全更新采用 Go 1.26.10，Node 原生类型剥离与零新增校验依赖的决定继续生效。

### 依赖基线：Go 1.25 + Gin v1.12.0

M0 的双方言依赖另有一项关键兼容约束，已记录在 [dual-database](../architecture/2026-10-16-wmind-dual-database.md)：SQLite 选用 `modernc.org/sqlite v1.51.0`，且通过锁定 `modernc.org/libc v1.72.3`、`modernc.org/ccgo/v4 v4.34.0` 与 `golang.org/x/*` 至 Go 1.25 兼容线，避免无意把构建基线抬至 Go 1.26。

`backend/go.mod` 的 `go` 指令为 **1.25.11**，Gin 为 **v1.12.0**。Dockerfile 构建阶段相应使用 `golang:1.25-alpine`（跟随 1.25 最新补丁；若镜像补丁低于 1.25.11，Go 的 `GOTOOLCHAIN=auto` 会自行取回对应工具链）。

`1.25.11` 不是随手写的补丁号，而是被迁移工具顶上去的：`github.com/golang-migrate/migrate/v4 v4.20.1` 的 `go` 指令就是 1.25.11。M0 里它负责跑两套迁移，属于不能省的依赖，因此整个模块的 Go 下限随之确定。CI 的 `setup-go` 直接读 `go-version-file: backend/go.mod`，与 Dockerfile 共用同一个事实来源。

下限由传递依赖顶上去，逐级量出来的结果是：

| Gin | 自身要求 | 实际结果 |
| --- | --- | --- |
| v1.10.0 | go 1.20 | 无 `quic-go` 依赖 |
| v1.11.0 | go 1.23.0 | 引入 `quic-go`，`go mod tidy` 仍把指令抬到 1.25 |
| v1.12.0 | go 1.25.0 | 同上 |

把 `go` 指令按住 1.23 需要强降级 `golang.org/x/net`（要求 1.25）与 `quic-go`（要求 1.24），等于为了一个数字去和模块图对抗，代价是长期停在不打补丁的传递依赖上。**因此接受 1.25，并把文档里的版本声明同步改掉。**

`quic-go`（HTTP/3）与 `go.mongodb.org/mongo-driver`（BSON 绑定）是 Gin v1.11+ 带来的、本项目用不到的传递依赖。它们会被编译进二进制，静态二进制因此约 21 MB。这是已知的、可接受的代价——用最新 Gin 换来的是两年的缺陷与安全修复。

### 笔记校验：Node 原生类型剥离，不引入 tsx

`package.json` 的脚本直接调用 `node --experimental-strip-types`，**没有 `devDependencies`，也不需要 `npm install`**：

```json
"verify-agent-note-tree": "node --experimental-strip-types .agents/skills/.../verify-agent-note-tree.ts"
```

Node 22.18+ 与 24 都支持该标志，因此本地与 CI 用同一条命令。根 `package.json` 设 `"type": "module"`，顺带消掉脚本运行时的 `MODULE_TYPELESS_PACKAGE_JSON` 警告。

## Alternatives considered

- **钉住 Go 1.23 + Gin v1.10，与文档一致** — 好处是零文档改动，且能甩掉 `quic-go` 依赖。被否是因为它把整个依赖树冻结在两年前，而唯一的收益是「文档里的数字不用改」；安全补丁的价值高于依赖精简，何况文档的版本号本来就只是计划值。
- **手动 `replace` / 降级 `x/net` 与 `quic-go` 以维持 1.23** — 能同时拿到「较新的 Gin」和「较低的 Go 下限」。被否是因为这会让模块图长期处于人为干预状态，每次升级依赖都要重做一遍，且降级传递依赖本身就是引入已知缺陷。
- **放弃 Gin，改用标准库 `net/http`** — 依赖树会小一个数量级，Go 下限也回到 1.21。被否的理由见 [backend-stack](../../proposed/architecture/2026-10-16-wmind-backend-stack.md)：分组路由与中间件链要自己写，而本项目有 7 个中间件、10 个路由组。
- **继续用 `npx tsx` 跑校验脚本** — 与 Skill 自带模板一致，改动最小。被否是因为本机 npm 缓存权限问题使其不可用；换成 Node 原生剥离后不但绕开了问题，还**彻底去掉了 Node 侧依赖**，CI 里也少一次安装。

## Consequences

- **收益**：`go mod tidy` 与 Dockerfile 的版本号一致且可复现；笔记校验在本地与 CI 用同一条命令、零依赖，`git clone` 后立刻可跑。
- **收益**：静态二进制约 21 MB（含 `quic-go`）。作为对照，若为省体积而钉住 Gin v1.10，可省下的量级有限，不足以抵偿版本陈旧。
- **代价与已知上限**：Go 下限抬到 1.25，部署方需要 1.25+ 的构建环境。若将来必须支持更低版本，重访信号是「有部署环境无法提供 Go 1.25」——届时再评估降 Gin 或换标准库。
- **代价**：`--experimental-strip-types` 名字里带 experimental。它已在 Node 22.18+ 与 24 稳定可用，但若某次 Node 升级改变了行为，`npm run verify-notes` 会直接失败（不是静默出错），排查成本低。

## Verification

- `cd backend && go build ./... && go vet ./...` 通过，`gofmt -l .` 无输出。
- `cd backend && go test ./...` 通过（config / httpapi / apperr 三包）。
- `npm run verify-notes` 在无 `node_modules` 的干净仓库中通过（M0 收尾时 16 篇笔记全部过树、格式与归档检查）。
- `grep -m1 '^go ' backend/go.mod` 得到 `go 1.25.11`；`go list -m -f '{{.Path}} {{.GoVersion}}' all` 中要求 1.25.11 的只有 `golang-migrate/migrate/v4`。
