# Agent Note: 由版本标签触发完整验证与发布

Status: implemented

## Problem

现有 CI 在每次 push 和 PR 运行完整验证，但没有自动生成 Release、部署压缩包或可拉取的镜像。版本标签、二进制内的版本和容器标签可能分别变化，部署者无法从发布页确认产物对应的源码。

## Decision

发布流水线仅由 `v*` 标签触发，保留原有数据库、前端、字体、配色和笔记检查。根 `VERSION` 是版本来源，两个 package 版本与其同步；`scripts/release.mjs check` 先验证标签一致性并运行发布工具测试，再经 `changelog` 和 `package` 生成更新日志、交叉编译 Linux amd64/arm64 服务并打包前端和部署文件。API/Web 构建仅推送 GHCR 的固定版本标签；两镜像均成功后再用 `buildx imagetools create` 将同标签镜像晋升为各自 `latest`，最后才创建或更新正式 Release，附上 Conventional Commit 更新日志、双架构部署包和 SHA256SUMS。

Go 和 Node 构建阶段固定为 BUILDPLATFORM，Go 通过 TARGETOS/TARGETARCH 交叉编译；仅 API 最终 Alpine 初始化需要目标平台模拟，避免在 QEMU 中编译 Go 或前端。Docker 构建参数 VERSION 写入后端 config.Version。Compose 默认使用 GHCR 镜像并保留本地 build 配置。

API 镜像在切换到 UID/GID 10001 前创建 `/data/uploads` 并递归设置 `/data` 属主。SQLite 挂载整个 `/data`，PostgreSQL 仅挂载 `/data/uploads`；两种全新命名卷均必须从镜像中的非 root 属主初始化，否则 PostgreSQL 的上传卷会被 Docker 以 root 目录创建，运行进程无法写入。

根目录作为构建上下文，因此 `.dockerignore` 位于根目录；放在 `deploy/` 不生效。构建上下文排除本地配置、依赖、运行数据和刚生成的 `release/` 压缩包，避免把私有配置发给构建器或重复传输部署包。

## Related notes

- [版本来源与部署包](2026-10-24-wmind-release-version-source.md) 负责版本同步、更新日志区间和打包白名单；本篇负责触发、质量闸门、镜像与最终 Release 的编排。
- [M0 CI 闸门](2026-10-17-wmind-m0-ci-gates.md) 部分重叠：保留检查内容和本机无 Docker 的边界；新方案取代每次 push/PR 触发的决定，不改写旧理由。
- [工具链版本基线](2026-10-16-wmind-m0-toolchain-baseline.md) 部分重叠：沿用 Go/Node/pnpm 版本配置。
- [备份恢复](../architecture/2026-10-21-wmind-backup-restore.md) 仅涉及部署包中既有脚本，不改变备份恢复行为。

## Alternatives considered

- **继续对每次 push/PR 运行并另加发布流程**：日常反馈更快，发布无需改变检查习惯；用户明确要求仅 tag 运行，因此完整检查移到标签触发的同一条流水线。
- **仅发布 amd64 镜像**：最省构建时间，也不需要 QEMU；但 arm64 服务二进制已有交叉编译产物，镜像不支持会让常见 ARM 设备无法按同一 Compose 部署。构建阶段原生执行，仅模拟轻量运行时步骤，保留双架构。
- **镜像发布前先建立正式 Release**：下载入口更早可见；镜像失败会留下缺少配套产物的正式版本，因此所有验证、压缩包与镜像成功后才发布。
- **各镜像构建时同时推送固定标签和 `latest`**：一次配置即可完成全部标签，无需额外晋升步骤；但 Web 构建失败时 API 的 `latest` 已更新，部署者会拉到不配套的版本，因此两个固定镜像都完成后才开始晋升。

## Verification

- Workflow 不由分支 push 或 PR 触发，标签检验在构建发布之前。
- 保留原有质量闸门；版本参数传到二进制和 Docker 构建。
- 两个架构的压缩包与校验和、两个多架构镜像和更新日志对应同一标签。
- 本机 `actionlint` 通过；Ruby YAML 静态解析确认 tag 触发、完整历史、发布顺序及两套 Compose 镜像/版本参数。Docker 构建、Compose 运行语义和 registry 发布由 CI 验证。
- `scripts/release-workflow.test.mjs` 先复现构建阶段提前更新 `latest` 的缺陷，再验证两个固定镜像、统一晋升和正式 Release 的先后顺序；修复后通过。
- 上传卷镜像契约先复现缺少 `/data/uploads` 挂载点的问题，再验证预建、递归属主和默认 UID/GID 的顺序；修复后通过。

## Consequences

GHCR 的首次包权限和仓库关联由 GitHub 校验；任何推送失败都阻止正式 Release。两个 `latest` 无法原子切换，晋升第二个失败时仍可能暂时不一致，但不会在另一镜像尚未构建时就提前切换；重跑同一标签补齐产物。部署包固定版本标签，不依赖 `latest`。私有仓库的镜像初始可能私有，部署者须具备拉取权限。发布流水线不在每次提交运行，因此开发提交需继续执行相关本地验证。原生构建阶段避免 QEMU 中运行编译器，仍付出双架构运行时层构建和两个镜像推送的时间。
