# Agent Note: 恢复暂存文件的回收与任务互斥

Status: implemented

## Problem

恢复在 uploads 同级创建 next/old 目录，旧清理器只扫描备份 WorkDir。崩溃后 next 残留不回收；old 可能保存未完成恢复的唯一原始文件，不能一并删除。WorkDir 的清理以目录时间判定预览过期，可能比解包完成后的真实到期时间更早，并且不同进程的任务互斥原本独立。

## Decision

WorkDir 使用独立跨进程任务锁，覆盖上传检查、备份、恢复与临时清理。预览原子落盘实际过期时间；扫描跳过当前和其他实例尚未到期的预览，残缺 marker 在目录宽限期后可回收。所有恢复同级目录按 uploads 目录名区分安装，next 从创建到交换均处于共享维护门的独占区，超过一小时的 next 可安全清理。已提交恢复的旧目录先更名为 garbage 再删除，删除失败或崩溃后可重试。未标明已提交的 old 和恢复前 ZIP 保留为恢复证据，不按名称推断安全。

已有笔记审计：[备份归档](../../implemented/architecture/2026-10-24-wmind-backup-archive.md)拥有格式与原子恢复契约，[后台备份](../../implemented/feature/2026-10-24-wmind-admin-backup.md)拥有配置/交互；本篇是部分重叠的临时文件生命周期补充。[备份保留](../../implemented/feature/2026-10-24-wmind-backup-retention-dedup.md)的远端归属与失败保留继续有效，不改远端删除边界。

## Alternatives considered

- 按前缀删除所有过期 restore-old，能最彻底省空间；但数据库提交与进程崩溃之间有不可推断窗口，会删除恢复依据，因此只收已确认提交后标记的 garbage。
- 只按目录 mtime 清理备份暂存，实现简单；但大文件解包耗时和跨进程任务使时间不能代表过期，采用任务锁和实际预览到期时间。

## Testing

先复现恢复 next 泄漏、未到期预览提前清理、共享 WorkDir 双任务并行以及残缺 marker 永不回收。修复后覆盖新旧安装隔离、符号链接/未知目录保留、活跃维护门不清理、live uploads 缺失时保留、任务锁失败不降级、真实备份恢复与过期预览。备份包整体运行 race 检查。

## Consequences

恢复独占维护窗口包括同文件系统暂存拷贝，换取明确的跨实例文件一致性。历史无归属标记的恢复目录和未确认提交的旧目录保守保留，需要人工确认；不清理用户提供的备份原文件。
