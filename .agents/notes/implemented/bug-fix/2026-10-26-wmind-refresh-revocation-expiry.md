# Agent Note: 全局安全撤销结束旧刷新令牌的重放窗口

Status: implemented

## Problem

自助改密为当前请求换发新会话后，其他设备会用旧 Refresh Token 正常发起刷新。现有实现把所有已撤销令牌都当作泄露重放，连带撤销刚换发的新 Refresh Token。改密之前已正常轮换的历史令牌也能触发同样行为。直接在事务外执行重放撤销，还可能跨过并发改密的安全边界。

## Decision

账号级安全撤销永久结束全部历史 Refresh Token 的有效期：设置 revoked_at 并把 expires_at 截断到撤销时刻，保留更早的到期时间和原撤销证据。更新包括已轮换但尚未到期的历史令牌。没有新增字段或迁移；受影响行数表示本次实际更新的行数，重复安全撤销不重复更新已撤销且已过期的行。

Refresh 取得共享安全行锁后重新读令牌，先拒绝过期，再处理未过期的已撤销令牌。正常单条轮换只设置 revoked_at，保留原到期时间，仍检测同一安全时期的令牌复制；安全撤销后旧令牌只拒绝，不影响新会话。

## Related decisions

检索刷新、轮换、改密及安全撤销后，[认证会话](../../implemented/architecture/2026-10-17-wmind-auth-session.md)部分重叠，本篇收窄其重放窗口到尚未安全过期的令牌。[管理员撤权](../../implemented/bug-fix/2026-10-25-wmind-admin-session-revocation.md)、[双因素认证](../../implemented/feature/2026-10-23-wmind-two-factor.md)与[自助改密](../../implemented/bug-fix/2026-10-26-wmind-password-session-rotation.md)共用账号级撤销，不改变其锁与状态原子性。备份恢复直接清理全部令牌，不需要同样标记。

## Alternatives considered

- 给每个 Refresh Token 保存 SessionVersion 可明确区分安全时期并保留原始到期时间，但需要双数据库迁移及备份格式升级；撤销后永久到期已有相同拒绝语义，可复用现有字段。
- 删除全部历史令牌能自然避免触发重放，但会丢失设备和撤销审计证据；保留行并截断到期时间保留现有清理边界。
- 只让仍活跃的令牌到期改动较小，但改密前已经轮换的历史令牌仍能跨越安全时期撤销新会话，必须覆盖尚未到期的全部历史行。

## Verification

测试先复现改密后旧设备刷新撤销当前替代会话。`TestPasswordSessionsRevokedAcrossInstances` 修复后覆盖改密前活跃及已轮换历史令牌均无法刷新，尝试后新会话仍可刷新；`TestPasswordSessionsWaitingReplayDoesNotCrossSecurityBoundary` 覆盖等待安全锁的旧请求不能撤销新会话。既有 `TestRefreshRotatesToken` 保留同一时期普通轮换重放的撤销行为。sqlc 生成双方言查询，仓储契约覆盖截止时间、不延长到期及幂等计数。

## Consequences

旧设备刷新不再使刚换发的当前会话退出，同时保留普通轮换的重放检测。已撤销历史行的 expires_at 提前，常规过期清理会更早移除它们。PostgreSQL 无实库时只检查生成与共享契约，真实事务并发由 SQLite 两实例测试覆盖。
