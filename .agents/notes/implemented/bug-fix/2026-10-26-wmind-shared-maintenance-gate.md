# Agent Note: 本地上传卷的跨实例维护门

Status: implemented

## Problem

进程内备份 Gate 无法阻止另一个实例在备份、恢复或资源回收时更新数据库与图片引用。两个进程同时认为自己持有独占区会导致数据库和上传目录不一致。

## Decision

生产 Backup Manager 初始化共享 Gate，在 uploads 同级的稳定隐藏锁文件使用 flock。普通 HTTP 与回收站任务持共享锁；备份捕获、恢复和资源回收持独占锁。每次获取独立文件描述符，适用于同进程多个 Gate 和共享本地卷的不同进程。锁不位于会被恢复 rename 的 uploads 内，也不进入上传备份。

PauseContext 等待在途操作、支持取消且返回锁错误；TryPause 供后台任务在有在途请求时跳过。锁打不开、路径不安全或平台不支持均拒绝操作，不降级成无锁。零值 Gate 保留现有内存调用兼容，生产通过 NewSharedGate 强制验证锁文件。所有实例必须升级到此协议，部署必须共享支持 flock 的上传卷及父目录。

## Historical note audit

[备份](../../implemented/feature/2026-10-24-wmind-admin-backup.md)与[回收站](../../implemented/feature/2026-10-24-wmind-trash-retention.md)部分重叠：保留原有门的语义，增加跨实例协调。本篇是上传资源回收的并发基础，不取代媒体权限或备份格式；未发现同主题活跃 proposed/rejected，其他笔记无需归档。

## Alternatives considered

- 只用 sync.RWMutex 无需文件访问且非常快，但只覆盖单个进程，不能保护多实例共享资源。
- 数据库 advisory lock 可跨机器协调，但两种数据库没有统一实现，且文件实际存储仍需共享。当前仅支持本地上传卷，使用卷上的操作系统锁可在进程退出时自动释放，避免新增锁表和续租。
- 将锁放进 uploads 能自然跟随挂载，但恢复会替换目录并产生两个锁 inode，锁必须放在稳定父目录。

## Consequences

两实例共享目录时维护操作互斥；每个普通请求增加一次锁文件打开与 flock。长期活跃请求会延后独占维护，取消后恢复正常服务。网络文件系统是否支持相同 flock 语义取决于部署，不将此方案当作对象存储协调器。

原有独立 Gate 复现测试失败（第二实例仍能进入），修复后覆盖两对象、真实子进程、共享请求排空、取消、TryPause 跳过及锁路径异常拒绝操作；备份与恢复现有定向测试同时运行。
