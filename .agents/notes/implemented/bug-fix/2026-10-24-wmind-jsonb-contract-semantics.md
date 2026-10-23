# Agent Note: 双方言文档契约按 JSON 内容与原始字节数分别验证

Status: implemented

## Problem

v1.0.0 首次 tag CI 在 PostgreSQL 导图创建契约失败。输入文档 31 字节，读回 `SizeBytes` 仍是 31，
但 JSONB 调整键顺序与空格，现有测试直接比较 `Document` 字节，因此错误拒绝了内容未变的文档。
共享 `sameJSON` 帮助函数已经用于分享和模板文档，但通过 float64 解码数字，会把超过 2^53 的相邻整数当成同一个数。

## Decision

共享仓储契约按 JSON 结构比较文档，数字通过 UseNumber 和精确有理数比较，忽略对象键序、空格与等值数字表示，
保留数组顺序、null、布尔、字符串及大整数差异。创建、Get、List、Update 和保存后重新读取均验证内容和元数据。
更新使用不同文档，防止忽略更新载荷也能通过测试。
`SizeBytes` 继续精确等于 service 提交给仓储的文档字节数，不根据 JSONB 回读的格式长度重算；运行时存储行为不变。

## Historical audit

- [双数据库架构](../../implemented/architecture/2026-10-16-wmind-dual-database.md)部分重叠：JSONB/TEXT 是既有方言差异，契约验证内容等价，不要求相同物理表示。
- [导图持久化](../../implemented/architecture/2026-10-18-wmind-map-persistence.md)部分重叠：保留原始请求字节上限和保存计数口径，本篇补齐测试覆盖。
- [结构内省连接修复](../../implemented/bug-fix/2026-10-24-wmind-parity-migration-connection.md)属于同一发布门禁但原因不同，不合并连接生命周期与文档断言问题。

## Alternatives considered

- **仓储回读前统一 JSON 字节格式。** 可以让原字节断言变绿，但会修改运行时文档表示，增加无必要解析并掩盖测试对 JSONB 的错误假设。应修改契约断言，保留成熟存储行为。
- **只将创建断言改成现有 float64 的 sameJSON。** 改动最小且能修复当前失败，但会漏过大整数内容损坏，也没有证明 Get/List/Update 路径保存新文档。采用精确数字及各读写阶段的内容断言。

## Verification

- PostgreSQL 17.11 先复现与 CI 一致的创建断言失败，确认输入和 SizeBytes 均为 31 字节，差异仅为 JSONB 格式。
- 12 项精确 JSON 比较用例先复现相邻大整数、精确小数、嵌套大整数三个错误合并；修复后全部通过。
- SQLite、PostgreSQL 共享仓储契约和语义比较单测的 `-race` 均通过。
- 设置隔离 PostgreSQL 地址后的 `go test ./... -count=1 -timeout=90s` 全部通过，包含真实结构内省、PostgreSQL 契约和回收站锁竞态；`go vet ./internal/repository/contracttest` 通过。

## Consequences

- 收益：测试承认 JSONB 的格式规范化，同时更严格地检测字段、数组顺序、类型和数字内容丢失；保存后读取的元数据与新文档内容一起验证。
- 代价：共享测试比较 JSON 数字时分配精确有理数，只影响测试成本，生产 JSON 解析与存储不变。
- 边界：SizeBytes 继续代表请求文档字节数，不能解释为 PostgreSQL JSONB 的物理磁盘占用。
