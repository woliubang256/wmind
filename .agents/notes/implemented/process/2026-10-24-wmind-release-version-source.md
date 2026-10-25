# Agent Note: 发布版本、压缩包与更新日志共享版本来源

Status: implemented

## Problem

两个 package.json 仍是 0.1.0，后端默认 dev，发布标签和部署镜像没有统一版本依据。用户要求 1.0.0 首发，并按末位加一、满十进位；普通 SemVer patch 递增到 1.0.10 不符合这个约定。发布压缩包还必须避免带入本机配置、数据库和 Git 凭据。

## Decision

更新日志来源部分由[按版本整理的用户说明](2026-10-25-wmind-curated-release-notes.md)取代；下述按提交区间汇总的段落保留原决定，版本进位、元数据一致性与部署包边界仍有效。

根目录 VERSION 保存不带 v 的版本，两个 package.json 保持相同值。scripts/release.mjs 提供 check、version、bump、changelog、package 命令；bump 将 1.0.9 进为 1.1.0，1.9.9 进为 2.0.0，只更新元数据，不自动提交或发布。Makefile 正式构建从 VERSION 注入版本，开发服务继续显示 dev。

changelog 读取本版本可达历史中最近的较小正式版本，按 Conventional Commit 类型整理区间提交；首次发布包含全部历史。package 为 Linux amd64/arm64 交叉编译独立服务，注入 v 前缀版本，只复制静态前端、示例配置、Compose、运维脚本、许可、版本和当次日志，生成 tar.gz 与 SHA256SUMS。压缩包内 Compose 移除源码 build 声明并固定当前镜像版本，直接拉取发布镜像。

## Related notes

- [标签发布流程](2026-10-24-wmind-tag-release.md) 部分重叠：本文负责元数据和产物边界，流水线负责调用及远程发布。
- [工具链基线](2026-10-16-wmind-m0-toolchain-baseline.md) 部分重叠：继续由 go.mod 与锁文件控制编译工具和依赖版本。
- [用户版发布日志](2026-10-25-wmind-curated-release-notes.md) 部分取代：日志从对应版本整理稿读取，不再用提交区间生成正文。

## Alternatives considered

- **npm version patch**：工具成熟、遵循通常 SemVer；但会生成 1.0.10，违反满十进位规则，且需要额外同步后端版本。
- **将 tag 作为唯一版本源**：打标签时最少维护文件；但未打标签时无法预览下一版，两个 package 元数据会继续漂移。VERSION 提供可审核的版本变更，发布前强制核对 tag。
- **直接压缩仓库目录**：实现简单，也能提供源码；本地执行可能带入 .git、真实环境配置和运行数据。部署产物采用显式白名单，源码由 GitHub 自带的源码附件提供。

## Verification

- `node --test scripts/release.test.mjs` 五项通过：跨位进位、tag/元数据不一致、首发/后续日志、白名单和符号链接拒绝。
- 本机实际构建两个架构的 tar.gz，检查 ELF 架构、执行权限、SHA256、固定版本及 Compose 不含源码 build。
- `make build` 构建本机服务，在隔离临时目录以 production 启动，自动迁移、健康检查通过，站点配置报告 v1.0.0；不读取开发配置或改变现有服务。
- 前端生产构建、配色和字体门禁通过；远程 Docker 构建与正式产物由标签流水线执行。

## Consequences

打包依赖已构建的 frontend/dist、Go 和 tar；不代替前端质量检查。Linux 包提供静态前端和服务二进制，非 Docker 部署需自行配置静态文件服务器以及 /api/、/uploads/ 代理。版本命令不自动创建 tag，避免一次更新元数据就意外发布。
