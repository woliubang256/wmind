# Agent Note: 桌面 DMG 构建固定 Intel macOS 运行机

Status: implemented

## Problem

1.1.7 补发桌面工作流时 Windows/Linux 构建成功，但 macos-latest 作业在未分配 runner 的状态排队 15 分钟后取消。GitHub 注解明确报告 hosted runner 无法取得，以及 macOS arm64 容量不足。网站发布不包含桌面正式安装包，macOS 作业取消使桌面 Release 汇总跳过。

## Decision

DMG 作业固定 GitHub 官方支持的 macos-15-intel 标签，避免 latest 跟随架构变更。现有无 cgo 的 Go/mygo 构建继续交叉生成 darwin/arm64 与 darwin/amd64，不减少平台、不换更新密钥。补发保持 1.1.7，失败的桌面标签可用精确旧值 lease 更新到仅包含 CI 修复的提交；已公开的网站标签不移动，应用代码保持相同。

## Related decisions

按 macOS、runner、桌面发布检索：[标签发布](../../implemented/process/2026-10-24-wmind-tag-release.md)部分重叠，继续保留双流水线与最后公开 Release；[桌面架构](../../implemented/architecture/2026-11-08-wmind-desktop-client.md)部分重叠，mygo、系统 WebView 和双架构交付保持不变。没有被完全替代的旧篇。

## Alternatives considered

- 原作业直接重试最省改动，可能在容量恢复后成功；但取消注解已指向 ARM runner 池，且 latest 会继续随平台迁移，因此选择固定 Intel 标签，而不是反复等待同一池。
- 本机生成并手工上传 DMG 能绕过 GitHub runner 排队；但会偏离仓库内可重复的签名、归档与汇总流程，还可能与重跑作业覆盖同一资产，因此继续让现有工作流生成全部产物。

## Verification

工作流契约先复现 latest 未固定架构，修复后验证显式 Intel runner、两种 darwin 目标、更新签名密钥及 packages/dmg 全部成功后的发布依赖。真实 CI 两组构建、公开 Release 和六个平台更新清单的版本、归档大小与签名属于发布时验收，不由本地契约测试代替。

## Consequences

Intel runner 也受 GitHub 容量与镜像生命周期限制；固定标签需要未来主动维护。无需改动桌面应用或重新提升版本，仅 CI 修复使桌面标签提交与已发布网站提交不同，必须核对应用源码没有差异。
