# Agent Note: Go 安全依赖与发布工具链基线

Status: implemented

## Problem

安全扫描发现图片解码、文本和网络库告警，修复版本要求 Go 1.26。仅更新 x/* 会留下标准库告警，仅更新本机 Go 又不能改变 CI 和发布镜像实际编译版本；Alpine 3.20 也已结束支持。现有 Go 1.25 基线因此无法继续作为本次安全更新的约束。

## Decision

`backend/go.mod` 的 Go 指令与后端构建镜像同步为 1.26.10，协调升级 x/crypto 0.58.0、x/image 0.47.0、x/net 0.61.0、x/text 0.43.0、x/time 0.16.0，及其必需的 sync/sys 模块。JWT 5.3.1 与 YAML 3.0.5 接受补丁更新，Gin、pgx、SQLite 驱动主版本保持。quic-go 使用同系列安全补丁 0.59.1，不为未启用的 HTTP/3 更换整代 API。CI 继续从 go.mod 读取工具链。

本篇部分取代[原工具链基线](../../implemented/process/2026-10-16-wmind-m0-toolchain-baseline.md)的 Go 1.25 约束；保留其 Node 原生剥离、Gin 选择与零新增校验依赖的理由。SQLite 纯 Go、单写者和双方言约束继续由[数据库笔记](../../implemented/architecture/2026-10-16-wmind-dual-database.md)持有。

基础镜像使用受支持的固定补丁：Go 1.26.10、Alpine 3.24.3、Node 22.23.4、Nginx 1.30.6；pnpm 同步到 10.34.8，Docker 与 CI 的安装都遵循相同锁文件和 workspace overrides。

## Alternatives considered

- Go 1.27.3 提供最新稳定工具链，但本次安全修复在 1.26.10 已可取得；只提升一个系列可以减小编译器、标准库行为与依赖迁移的组合范围。
- 坚持 Go 1.25 并选择旧 x/* 补丁可以降低开发环境变更，但会持续依赖人为版本钳制，且无法使用目前已修复的图片与文本模块，因此解除旧约束。
- 整体升级 SQLite、Vite、路由、国际化和 MathJax 能一次更新版本数字，但会扩大与权限修复无关的行为变化；这些迁移独立安排，不用已知安全告警为全量跨代升级背书。
- 使用浮动镜像标签方便自动获取补丁，但同一提交的重新构建会改变工具链，故固定补丁版本并在下一次安全检查显式更新。

## Verification

- Go 自动取得 1.26.10；`go mod tidy`、`go mod verify` 通过。隔离副本以原业务代码与新依赖运行 `go test ./... && go vet ./...` 全部通过，PG 连接显式关闭；安全修复的行为回归由对应修复用例单独验证。
- `CGO_ENABLED=0` 的 Linux amd64/arm64 服务二进制交叉编译通过；前端 pnpm 10.34.8 冻结安装通过且未改变锁图。
- `govulncheck v1.9.0` 扫描全量模块与 Linux amd64 实际服务入口均退出 0，可达漏洞和已导入包漏洞均为 0。剩余纯模块级 `GO-2026-5932` 指向无修复版的 x/crypto/openpgp；`go list -deps ./cmd/server` 确认未导入该包，不能通过替换 bcrypt 所在整个模块来消除此类提示。
- Docker Hub 验证全部固定标签有 amd64/arm64；发布流程 4 项测试及备份/恢复脚本 bash 语法检查通过，版本源一致性断言通过。

## Consequences

更新消除本轮扫描中的标准库、图片、文本、网络和 QUIC 安全告警，原有服务与静态交叉编译契约继续成立。代价是开发与打包环境必须取得 Go 1.26.10；固定镜像补丁仍需定期显式更新。PG 与 Docker 本机不可用，真实数据库回归、镜像构建及整栈代理冒烟继续由 CI 完成，本地 SQLite 测试与公开镜像元数据不能替代这两项。
