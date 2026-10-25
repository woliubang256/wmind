# Agent Note: 分享改密即时撤销既有访问凭证

Status: implemented

## Problem

分享密码重设后，旧密码校验失败，但此前签发的 X-Share-Access 只绑定分享 UID，仍能读取导图直到 30 分钟过期。分享设置采用读、合并、整行写入，延迟的旧 PATCH 还可能覆盖新密码哈希，恢复已经失效的密码和凭证。公开图片授权复用公开分享读取时也必须服从同一撤权边界。

## Decision

分享 JWT 增加密码修订指纹：用签名密钥对明确用途前缀、分享 UID 和当前 bcrypt 哈希计算 HMAC-SHA256。凭证读取时与数据库当前哈希重算比较，不在 JWT 暴露原哈希或可读密码。bcrypt 每次重设生成新盐，因此重设成相同密码也撤销旧凭证；普通下载、备注与期限变更保留哈希，不要求重新验密。移除密码允许匿名读取，重新添加密码后不恢复历史凭证。旧版无指纹凭证失败关闭，访客重新输入密码获得新凭证。

UpdateShare 必须提供读取时的 ExpectedPasswordHash，SQL 同时匹配该快照；改密已经发生时，延迟旧 PATCH 安全失败为既有 SHARE_NOT_FOUND，不能回写旧哈希。服务端不自动重试或覆盖用户较新的密码。无 schema 迁移，两数据库共享同一查询。

## Related decisions

检索分享、密码与会话笔记后，[分享架构](../../implemented/architecture/2026-10-21-wmind-share-links.md)部分重叠，本篇取代其“改密码不影响已发放凭证”的已知缺口和并发 PATCH 可忽略的前提，保留公开 DTO、JWT issuer 隔离、失效与浏览状态规则。[分享密码明文回显](../../implemented/bug-fix/2026-10-25-wmind-share-password-plaintext.md)继续持有属主可读副本与旧密文兼容规则，本篇不改变存储格式。没有需要归档的完整重复笔记；账号登录会话版本与本篇分享访问码撤权独立。

## Alternatives considered

- 增加随机访问版本列能明确表达每次改密，并独立于密码算法；但需要两数据库迁移、备份 schema 与旧记录兼容。bcrypt 的加盐哈希已是每次重设都变化的持久事实，使用 HMAC 指纹满足当前撤权且不把密码哈希暴露给访客。将来支持不改密码而单独踢掉访客时应重新评估独立版本。
- 继续等待 30 分钟过期可保持访问不中断且不增加验证成本；但用户主动重设密码表达即时收回旧访问的意图，等待窗口会使图文继续泄露，因此旧凭证必须重新验密。
- 只给 JWT 加指纹改动最少，顺序操作能正确撤权；但读-合并-整行写的旧 PATCH 会恢复旧哈希，故必须同时保护数据库写入快照。

## Verification

- `TestSharePasswordResetRevokesPreviouslyVerifiedAccess`、`TestShareAccessSurvivesUnrelatedSettingsAndNotPasswordRemoval` 和 `TestShareStaleSettingsUpdateCannotRestorePreviousPassword` 先复现旧凭证仍可访问及延迟 PATCH 回写旧密码，修复后通过。
- 修改密码、重设同值、清除后重设原值均拒绝此前凭证，新密码可正常验密和读取。
- 无关配置不撤销凭证；跨分享、跨导图、跨属主复用失败，公开响应和 JWT 不含可读密码或原始哈希。
- 延迟旧设置 PATCH 不可恢复旧密码、旧凭证；两数据库生成 SQL 保留快照条件。
- 旧版凭证、篡改、过期、错误 issuer 或算法失败关闭；不改变分享 UID 和 30 分钟 TTL。
- auth、service、httpapi 的 `TestShare`、SQLite 仓储 `TestRepositoryContract/share` 与分享密码重启集成测试通过；PostgreSQL 包编译通过，但没有实库配置。首轮使用本机 Go 1.26.4 与隔离临时 modfile，仅调整最低工具链行，不改仓库依赖；正式升级工具链的整体回归由依赖更新单元执行。

## Consequences

改密立即关闭旧访问凭证，且不需要迁移分享记录、密码可读副本或备份格式；无关分享设置仍保留访客访问。代价是所有运行实例须升级后才能兑现即时撤权，旧二进制仍按旧逻辑放行。部署后原来已验证密码的访客需要重新验密，已经下发到浏览器的内容无法收回。在途且已经读到旧快照的请求不回滚，下一次请求使用当前数据库哈希判定。并发密码快照冲突返回既有 404，调用方须重取后修改；同一密码修订内的其他独立设置仍为最后写入胜出。未配置 PostgreSQL 测试库时仅声明共享 SQL 与编译验证。
