# Agent Note: 同时支持 PostgreSQL 与 SQLite 两种数据库，双方言仓储层 + 两套 compose

Status: implemented

## Problem

需求方在需求评审后追加一条要求：**数据库同时支持 SQLite 与 PostgreSQL；本地开发使用 SQLite；线上部署提供两套 compose。**

这条要求推翻了三项既有决策的边界：

1. **ADR-003（数据存储）** 原本定的是「PostgreSQL 16 + pgx v5 + sqlc」。现在要加一个方言。
2. **后端选型笔记**里明确写过「SQLite 单文件、零运维，很有吸引力，但保留为选项而非现在做」——现在就是做的时候。
3. **部署文档**原本只有一套 compose（web + api + db）。

真正要回答的不是「能不能支持两种数据库」（能，写两套 SQL 就行），而是三个更具体的问题：

**问题一：怎么避免两条代码路径长期分叉？**
最省事的做法是让 service 层判断方言、写两套逻辑。这在第一个月没问题，到第六个月会变成每加一个功能都要记得改两处、且总有一处忘了改。分叉点必须被**限制在少数几处**，且这几处要是显式的、可静态检查的。

**问题二：SQL 的公共子集到底有多小？**
SQLite 与 PostgreSQL 都自称支持标准 SQL，但实际重叠区比想象中窄。已知的硬差异至少有四类：并发控制（`SELECT ... FOR UPDATE` 在 SQLite 不存在）、类型系统（`JSONB` / `TIMESTAMPTZ` / `SERIAL` 都没有对应物）、时间函数（`now()` 的语义与精度不同）、DDL 能力（SQLite 没有 `ALTER COLUMN`、没有 `ADD CONSTRAINT`）。如果这些差异散落在几十个查询里，维护成本会失控。

**问题三：能力悬崖在哪？**
SQLite 有一个不可绕过的限制——**单写者**。它决定了「一个实例只能跑一个 `api` 容器」。需求方要的「线上也提供 SQLite 的 compose」在功能上成立，但必须把这个边界写清楚，否则运维方会在某天尝试扩容到 2 个副本，然后遇到莫名其妙的写阻塞。

同时还有一个容易被忽略的约束：**用 CGO 版 SQLite 驱动会破坏现有的构建方式**。后端 Dockerfile 是 `CGO_ENABLED=0` 的多阶段 alpine 构建，引入 `mattn/go-sqlite3` 需要 gcc 和 `CGO_ENABLED=1`。

## Decision

### 双方言并存，由环境变量选择

```
WMIND_DB_DRIVER = sqlite | postgres     # 默认 sqlite
WMIND_SQLITE_PATH = /data/wmind.db      # 仅 driver=sqlite，默认值够用
WMIND_DATABASE_URL = postgres://...     # 仅 driver=postgres，条件必填
```

启动时按驱动加载对应的迁移集与 sqlc 生成包。**校验规则是「按当前 driver 只校验它需要的那个」**，无关的那个即使填了也不读、不报错——这样切换 driver 时不必清理旧变量。

### SQLite 驱动选 `modernc.org/sqlite`（纯 Go）

不用 `mattn/go-sqlite3`。理由是构建方式：`modernc.org/sqlite` 是纯 Go 实现，`CGO_ENABLED=0` 依然成立，静态二进制与交叉编译不受影响。纯 Go 版本在写入性能上确实略逊，但在本项目量级（单实例、一个组织）下不可感知。

### 数据访问：sqlc 双 target，而不是运行时方言判断

`db/sqlc.yaml` 配两个 target，从同一份 `.sql` 源生成两个包：

```
internal/repository/
├── postgres/    ← sqlc engine: postgresql，产出 pgdb
└── sqlite/      ← sqlc engine: sqlite，产出 sqlitedb
```

两者实现同一组 repository 接口。**业务代码（service / handler）只依赖接口，不 import 任何一个具体包**——这条由静态检查强制（见验收标准 7）。

查询按可共享程度分三层目录：

```
db/queries/
├── shared/      # 两边都能跑，占绝大多数
├── postgres/    # 方言特有（JSONB 路径查询、pg_trgm 模糊搜索）
└── sqlite/      # 方言特有（对应的降级实现）
```

### 事务：`TxManager.WithTx(ctx, fn)` + ctx 携带事务句柄

service 层拿到的 repository 是「未绑定连接」的，事务通过 ctx 传递：

```go
err := tx.WithTx(ctx, func(ctx context.Context) error {
    if err := maps.Update(ctx, m); err != nil { return err }
    return revisions.Insert(ctx, r)
})
```

repository 内部用 `dbtx(ctx)` 取「事务句柄或普通连接」——有事务时走事务，没有时走连接池。**service 层完全不感知方言，也不感知是否在事务中**。这是把方言差异关在仓储层的关键设计。

### sqlc 公共查询的解析约束

`queries/shared/*.sql` 和两个方言专属查询文件保持 ASCII-only。使用 sqlc v1.31.1 实测，`sqlc.arg(name)` 在 SQLite engine 下会把参数标记回写到 SQL 文本；只要同一查询中有非 ASCII 注释或字面量，字节偏移处理会破坏周边 SQL（例如生成 `SELEcid`、`UPDATE m?3`），报错还会指向无关的 LIMIT/metadata。

此外，LIMIT/OFFSET 参数名不用 `limit` / `offset`（PostgreSQL 将其视作保留关键字），统一命名为 `page_size` / `row_offset`。生成参数与 domain.Page 字段的映射留在仓储实现。

### 三条硬性 SQL 纪律

这三条是为了让「公共子集」不随开发推进而悄悄缩小：

1. **时间一律由 Go 计算后作为参数传入，禁止在 SQL 中调用时间函数。**
   这是最隐蔽的差异源：`now()`、时区处理、微秒精度、字符串格式在两边都不同。把时间变成入参，差异就消失了。
   - PostgreSQL：`created_at = $1`（`time.Time` 参数）
   - SQLite：同样 `created_at = $1`，由驱动序列化为 ISO-8601 UTC

2. **SQL 必须落在双方言公共子集内。** 新写的查询若用了某一方言的特性，必须同时提供另一侧的等价实现，且**两侧放在同一个提交里**。

3. **迁移集必须成对修改。** `db/migrations/postgres` 与 `db/migrations/sqlite` 的版本号序列必须完全一致。由 `verify-migration-parity` 在 CI 中强制——改一边忘改另一边直接构建失败，不会留到运行时。

### 并发控制：乐观锁保留，行锁换实现

`maps.version` 乐观锁是跨方言的，**完全保留**（`WHERE id = ? AND version = ?` → 409 `MAP_VERSION_CONFLICT`）。

事务内的防竞态则分叉，且这是**唯一一处**必须显式分叉的地方：

| 方言 | 手段 |
| --- | --- |
| PostgreSQL | `SELECT ... FOR UPDATE` |
| SQLite | `BEGIN IMMEDIATE`（进入写事务即取写锁）+ 连接池 `SetMaxOpenConns(1)` |

### 方言分支白名单（共 7 处）

差异必须集中在这 7 处，任何第 8 处出现都视为设计问题：

1. 连接装配（`main.go` 的 `switch cfg.DB.Driver`）
2. 事务开启方式（`TxManager`）
3. 时间字段的读写序列化
4. JSON 字段（`JSONB` ↔ `TEXT`）
5. 模糊搜索（`pg_trgm` `ILIKE` ↔ `LIKE`）
6. 冲突/唯一约束错误的识别（错误码与错误信息不同）
7. 自增/返回 ID 的写法（`RETURNING` 支持度不同）

### SQLite 运行时约束（不可协商）

| PRAGMA / 配置 | 值 | 原因 |
| --- | --- | --- |
| `journal_mode` | `WAL` | 读写不互相阻塞；崩溃安全 |
| `busy_timeout` | `5000` | 写竞争时等待而非立即 `SQLITE_BUSY` |
| `foreign_keys` | `ON` | SQLite 默认关闭外键，必须显式打开 |
| `synchronous` | `NORMAL` | WAL 下的合理折中 |
| `temp_store` | `MEMORY` | 临时表放内存，减少磁盘 I/O |
| 连接池 | `SetMaxOpenConns(1)` | 单写者模型，多连接只会互相阻塞 |

配套的非代码约束：

- **只允许单实例部署**，不支持 `api` 多副本。
- **`data` 卷必须是本地块设备**，不支持 NFS / SMB / 云盘挂载（文件锁语义不可靠）。
- **备份用 `VACUUM INTO`**，不能 `cp wmind.db`（WAL 未合并时拷出来的是撕裂快照）。

### 两套 compose

同一个 `api` 镜像，差异只在环境变量与是否包含 `db` 服务：

| 文件 | 服务 | 卷 | 说明 |
| --- | --- | --- | --- |
| `docker-compose.yml` | `web` + `api` | `data`（含库 + 上传） | **默认**，两容器 |
| `docker-compose.postgres.yml` | `web` + `api` + `db` | `pgdata` + `uploads` | 可选，三容器 |

### 一个顺带的大收益：本地开发摆脱 Docker

集成测试用 `t.TempDir()` 下的临时 SQLite 文件 + 真实迁移，**不起容器**。因此：

- 日常开发和跑测试都不需要 Docker。
- CI 里跑集成测试也不需要 Docker 服务。
- 重置数据库就是 `rm data/wmind.db`。

这其实是选 SQLite 作默认 driver 最实在的收益——它把「每天发生几十次」的操作从秒级降到毫秒级。

## Alternatives considered

### 只支持 SQLite，放弃 PostgreSQL

部署最简单（两容器、一个文件、零密码），代码量最少，备份最轻。**未选**：SQLite 无法水平扩展，且多实例、大团队、需要 `pg_trgm` 全文检索与 JSONB 路径查询的场景没有出路。放弃 PostgreSQL 等于把产品的能力上限锁死在「小团队单机」——而这是一个要长期演进的自托管产品，上限不该现在就钉死。

### 只支持 PostgreSQL（即 ADR-003 的原结论）

维护成本最低、能力上限最高，且已有完整设计。**未选**：被需求方明确否决。更实质的理由是本地开发体验——「改一行代码要先起数据库容器」这件事的损耗是每天发生的，而 SQLite 恰好能彻底消除它。

### 用 ORM 抽象双方言（GORM / Ent）

由 ORM 处理方言差异，只写一份模型定义，无需两套 SQL。**未选**：ORM 的方言适配本质是「最低公共分母」——简单查询能抹平，复杂查询仍要落回方言特有写法，此时既失去了 ORM 的便利又多了它的不透明。而且 ADR-003 已经因为「SQL 不透明、隐式行为多」否掉过 ORM，这个理由在双数据库场景下只会更成立。

### 运行时用查询构造器生成 SQL（如 squirrel）

单份代码按方言生成不同 SQL，理论上比 ORM 更可控。**未选**：会丢掉 sqlc 的编译期类型安全——而这是 ADR-003 选 sqlc 的核心理由。且查询构造器的方言适配同样是「最低公共分母」，问题只是从 ORM 转移到了构造器。

### 开发用 SQLite、生产强制 PostgreSQL

开发体验好，生产只维护一个方言，看起来是最务实的方案。**未选**：两个原因。一是需求方明确要求线上也提供 SQLite 的 compose（内部隔离环境、单机部署的场景确实存在）。二是「开发用 A、生产用 B」本身就是一类经典事故来源——所有方言差异只在生产暴露，而且是在真实用户的数据上暴露。

### SQLite 用 `mattn/go-sqlite3`（CGO）

更成熟、社区更大、写入性能更好。**未选**：需要 gcc 与 `CGO_ENABLED=1`，直接破坏现有的 `CGO_ENABLED=0` 多阶段 alpine 构建，静态二进制与交叉编译都没了。纯 Go 驱动的性能损失在本项目量级下不可感知，不值得为此换掉整个构建方式。

### SQLite 用双连接池（1 写 + N 读）

读写分离：写走单连接，读走 N 个连接的池，读并发不受单写者限制。**未选（本期）**：需要维护两套连接管理，且会话级 PRAGMA 要分别配置（尤其 `foreign_keys` 是连接级的），复杂度换来的吞吐在本项目量级下用不到。作为二期升级路径记录在案——只有 SQLite 用户规模超出预期时才需要。

### 共用一套迁移文件，用「方言无关 SQL」写成

不维护两套迁移集，只写一份，靠 SQL 的子集性质让两边都能执行。**未选**：在纯 DDL 场景下这个想法很快会撞墙——SQLite 没有 `ALTER COLUMN`、没有 `ADD CONSTRAINT`、`JSONB` / `TIMESTAMPTZ` / `SERIAL` 都没有对应物。为了写出一份两边都能跑的 DDL，会把 PostgreSQL 侧的设计压到 SQLite 的水平，这是本末倒置。分开维护两套、用 CI 保证版本号一致，是更诚实的做法。

## Verification

- `sqlc generate` 同时产出 `pgdb` 与 `sqlitedb`，生成结果纳入版本控制；CI 重生成并检查产物差异。
- 两套真实迁移由 `cmd/verifyparity` 校验：版本序列配对，SQLite 内省恰有预期业务表，连接 PostgreSQL 时比较真实表/列/类型/索引。
- 同一份用户与导图契约测试跑 SQLite 临时数据库；设置 `WMIND_TEST_DATABASE_URL` 时同样的用例跑 PostgreSQL。
- `cmd/dialectcheck` 检查业务层不直接依赖具体方言仓储、handler 不直连仓储；覆盖测试验证违规样例会失败。
- `go test ./...`、`go vet ./...` 与 `CGO_ENABLED=0 go build ./cmd/server` 通过。
- compose 以两个独立文件交付；由于开发环境没有 Docker，尚未本机启动验证，部署阶段仍需在装有 Docker 的环境中执行验收。

## Consequences

- **收益**：同一二进制支持默认 SQLite 与 PostgreSQL；领域接口隔离仓储，事务上下文由两侧实现；SQLite 集成测试不依赖 Docker。
- **收益**：迁移版本序列、数据库结构、生成代码与方言边界有可运行的门禁，减少本地只测 SQLite 时的漂移风险。
- **代价**：维护两套 DDL、两份生成物及两个仓储映射；每项 schema / SQL 方言差异必须成对处理。PostgreSQL CI 服务是完整验证的一部分，不能省略。
- **代价与边界**：SQLite 仅支持单 API 实例、本地文件系统卷；`BEGIN IMMEDIATE` 粒度比 PG 行锁更粗。驱动切换不搬迁数据；备份/恢复工具及完整双数据库 E2E 随后续里程碑完成。
- **已知环境限制**：Compose 文件尚未在本机验证（本机没有 Docker），不得把静态审阅当作 Docker 部署验收。
