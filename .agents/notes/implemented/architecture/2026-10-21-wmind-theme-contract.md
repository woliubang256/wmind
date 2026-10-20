# Agent Note: 仓储契约测试补齐主题表

Status: implemented

## Problem

路线图 M6「测试补齐」里有一条「仓储契约测试覆盖全部表」。实际情况是：契约套件
（`internal/repository/contracttest`）覆盖了 `users` / `maps` / `refresh_tokens` /
`settings` / `audit_logs` / `share_links` / `templates` 七张表，而 `themes` 表——

- 有 `domain.ThemeRepo` 接口，
- 两种方言都实现了（`sqlite/themes.go`、`postgres/themes.go`，各带
  `var _ domain.ThemeRepo = (*ThemeRepository)(nil)` 的编译期断言），
- `cmd/server` 里真的接线了，`service/theme.go` 有完整业务逻辑，

**却一条契约测试都没有**。编译器能保证「方法签名对得上」，保证不了「两种方言的
行为一致」——`is_builtin` 在 SQLite 是 `INTEGER`、在 PostgreSQL 是 `BOOLEAN`，
`UpdateTheme` 的 `RETURNING *` 在两种方言里对「行不存在」的表现也不同。这些差异
只有跑起来才知道。

剩下四张表（`files`、`map_revisions`、`user_devices`、`user_tokens`）在迁移里
建了表，但**没有任何读写代码**——docs/03 §5 已写明它们是二期预留（邮件令牌、
设备管理、版本历史），不是漏测。

## Decision

给契约套件加一段 `custom theme lifecycle, JSON config round-trip, and owner isolation`，
并把 `Themes` 加进 `contracttest.Repos`（两种方言的 `repository_test.go` 各自传入
自己的实现）。

覆盖的判据按「最容易在两种方言间分叉」的顺序挑：

| 判据 | 为什么值得测 |
| --- | --- |
| `config` 是完整 JSON，2^24+1 原样往返 | 任何一层把 JSON 当 `float64` 解码，这个大整数就会变成 16777216。模板那条用的是同一招 |
| `is_builtin` 恒为 false | `CreateTheme` 的 SQL 里写死 `false`。若改成参数，一个构造出来的请求就能造出删不掉的「内置」行 |
| `sort_order` 恒为 0 | 同上，接口建的主题不该能指定排序位置 |
| 列表按 `sort_order, created_at` 升序 | 两行 `sort_order` 都是 0 时顺序由创建时间决定，这是前端分组的隐式依赖 |
| 跨用户 `GetByUID` / `Update` / `Delete` 一律 `ErrNotFound` | 不能返回「无权限」——那会泄露 uid 是否存在 |
| `Update` 不动 `uid` / `category` / `created_at` | SQL 只 SET 三列，测的是「没有多改」 |
| 删除后再删一次是 `ErrNotFound` | `DeleteTheme` 走 `execrows`，零行必须映射成 not found 而不是成功 |

## Consequences

- SQLite 侧 12 个契约子测试全绿（新增 1 个）；PostgreSQL 侧同一份代码在 CI 跑
  （本机没有 PostgreSQL，`WMIND_TEST_DATABASE_URL` 为空时 `t.Skip`）。
- **四张预留表仍然没有契约测试，这是刻意的**：没有代码可测。等二期接邮件能力
  （`user_tokens`）、设备管理（`user_devices`）、版本历史（`map_revisions`）、
  文件表（`files`）时，补的是仓储实现 + 对应的契约段，两件事一起做。
- 契约套件现在有 8 个仓储、12 段子测试。再加仓储时 `Repos` 结构体要加一个字段，
  两个方言的测试文件各加一行——结构体而不是位置参数就是为了这个。

## Alternatives considered

- **把 `themes` 的测试写在 `sqlite/themes_test.go`**：能测到 SQLite 的行为，但
  PostgreSQL 那边就得再抄一份，两份一旦分叉，恰恰是契约套件要防的事。
- **给四张预留表也写契约测试**：没有仓储实现，只能直接对 `sql.DB` 写 SQL 断言，
  测的是「表建出来了」。迁移文件本身已经是这件事的唯一真相，再测一遍是重复。
- **直接删掉四张预留表**：docs/03 明确写了「表名与 `purpose` 取值一经确定即视为
  契约，二期不得改名」。删了会让二期改表结构，而建表成本是零。
- **用 `sqlc` 的 query 覆盖率做门禁**（每个 query 至少被一次测试执行）：要写一个
  插桩层去 hook `database/sql`，收益不如按行为写断言直接。
