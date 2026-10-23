# Agent Note: 双方言结构内省释放 PostgreSQL 迁移连接

Status: implemented

## Problem

`cmd/verifyparity` 将 PostgreSQL 的 `*sql.DB` 限制为单连接，先跑迁移，再用同一个池查询表、列与索引。
golang-migrate 的 pgx/v5 驱动为会话级迁移锁固定持有一个 `*sql.Conn`，只有驱动 Close 才归还。
现有工具刻意不调用 migrator Close 来避免关闭调用方数据库，结果唯一连接始终被占用，内省查询等待到两分钟超时。
SQLite 驱动不固定连接，因此本地不设置 PostgreSQL 测试地址时无法发现这个问题。
真实迁移测试另有过时预期：迁移 0003 新增 `user_two_factor` 后，SQLite 表集合断言仍只列 12 张表，导致 CI 单测固定失败。

## Decision

迁移与内省分别打开数据库连接。迁移函数拥有传入的专用 `*sql.DB`，返回前关闭迁移器、source 和数据库驱动；
内省使用另一条单连接池。SQLite 临时文件同样先完成并关闭迁移，再打开内省连接，统一所有权，避免给同一个函数保留两种关闭语义。
命令未设置 `WMIND_TEST_DATABASE_URL` 时仍明确提示跳过 PostgreSQL，仅执行 SQLite 和迁移文件检查。
真实 SQLite 表集合同时包含 `user_two_factor`，并验证其 `user_id`、`state`、`revision` 列。

## Historical audit

- [M0 CI 闸门](../../implemented/process/2026-10-17-wmind-m0-ci-gates.md)部分重叠：保留原有双方言门禁与本地显式跳过约定，本篇补充连接生命周期。
- [双数据库架构](../../implemented/architecture/2026-10-16-wmind-dual-database.md)部分重叠：SQL 方言和仓储边界不变，仍由真实迁移内省比对表、列、类型及显式索引。
- [M1 验收](../../implemented/process/2026-10-17-wmind-acceptance-m1.md)是历史验收结果，不修改其当时 PostgreSQL 待 CI 复核的结论。
- [两步验证](../../implemented/feature/2026-10-23-wmind-two-factor.md)部分重叠：该功能新增的独立状态表必须纳入现有真实迁移断言，本篇不改变其业务设计。

## Alternatives considered

- **增加 PostgreSQL 连接池容量。** 可以立即让内省查询拿到另一条连接，改动只有一行；但迁移驱动仍固定占用连接，隐藏所有权错误，后续重复运行会继续泄漏。保留单连接约束并隔离生命周期能验证连接真正释放。
- **直接在现有迁移函数调用 migrator.Close。** 可以释放固定连接，但也会关闭供后续内省使用的 `*sql.DB`，把等待超时变成 database is closed；必须同时分离两个数据库句柄。

## Verification

- 真实 PostgreSQL 17.11 子进程复现用例先在旧实现十秒超时失败；修复后普通回归 0.09 秒完成，race 回归约 1.2 秒完成。
- 空库首次迁移和 ErrNoChange 重复执行均通过，表、列、类型、显式索引与 SQLite 全结构一致；两侧均存在迁移 0004 的 `idx_maps_trash_retention`。
- `go test -race ./cmd/verifyparity`、无 PostgreSQL 地址的该包测试、`go vet ./cmd/verifyparity` 均通过。
- 实库 `go run ./cmd/verifyparity` 输出两套迁移集一致；无 PostgreSQL 配置时也成功并显示跳过提示。

## Consequences

- 收益：PostgreSQL 内省能在单连接约束下实际完成，CI 不再等待迁移驱动占用的唯一连接；source、驱动和数据库句柄按归属释放，关闭错误也会返回。
- 代价：两侧在迁移和内省之间重新打开一次数据库，工具多一次建连；SQLite 临时文件使这次重开不会丢失迁移结果。
- 边界：PG 驱动初始化会执行无 context 的上游调用；子进程回归以短时限防止连接等待挂住测试进程，本修复不改变上游迁移超时策略。
- 回归时限包含首次迁移开销，测试只连接明确提供的隔离测试数据库；没有 PostgreSQL 地址时跳过实库子用例。
