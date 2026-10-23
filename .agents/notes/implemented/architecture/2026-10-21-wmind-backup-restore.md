# Agent Note: 备份与恢复（`wmind db backup` + deploy/scripts）

Status: implemented

## Problem

M6 的部署项里，备份与恢复是唯一「做错了会静默丢数据」的一格。文档 §7 早就写了
脚本，但那只是草图：里面 `$COMPOSE` 用字符串拼接、`alpine` 不锁版本、没有卷
存在性检查、清理逻辑对所有文件生效、`.env` 完全没提。按它抄下来的脚本会在几
个地方安静地出错：

- `docker run -v ./backups:/backup` —— 相对路径会被当成**卷名**，docker 会
  新建一个空卷，于是 tar 出来一个只有 `.` 的包，脚本还打印「备份完成」；
- 卷不存在时 `docker run` 同样新建空卷，结果一样；
- `find "$BACKUP_DIR" -name 'wmind-*' -mtime +30 -delete` 会连用户自己放进
  backups 目录、恰好以 `wmind-` 开头的文件一起删。

还有一个更根本的问题：**SQLite 没有可用的备份手段**。`cp /data/wmind.db` 在
WAL 模式下拿不到最近的提交（数据还在 `-wal` 里），运行中拷还可能撞上正在写的
页。镜像里也没有 `sqlite3` 命令行工具可用。

所以这一格要落地两件东西：一个能安全产出 SQLite 快照的入口，和两个真正能跑
的脚本。

## Decision

### 备份走服务自带的子命令，不引入 `sqlite3`

`wmind db backup [--out <path>]` 是后端二进制自己的子命令，内部执行
`VACUUM INTO ?`（路径用绑定参数传，不拼字符串）。

为什么不用镜像里的 `sqlite3`：alpine 运行镜像默认没有它，装进去等于多一个需要
跟随升级、且在 CGO/架构上还要对齐的依赖。服务本身已经链了
`modernc.org/sqlite`（纯 Go），用自己就是零新增依赖。

为什么是 `VACUUM INTO` 而不是 `cp` 或 `.backup`：

- 它是**单事务读快照**，拿到的是某个一致的时间点，不会撕裂；
- 它顺带**合并 WAL 并整理碎片**，产物是自洽的单文件，不含 `-wal`/`-shm`，
  可以直接当恢复源；
- 它**可以在服务运行时执行**，不需要停机。

子命令拒绝覆盖已存在的目标文件。重跑同一个 `--out` 会明确报
`备份文件已存在`，而不是默默毁掉上一份——备份工具最不该有的行为就是「看起来
成功了，其实把好备份换成了半成品」。

### 方言检查放在 `cmd/server`，不新开 CLI 包

`db backup` 只对 SQLite 有意义，PostgreSQL 下应该直接指向 `pg_dump`。这个分
支按项目硬边界只能出现在 `cmd/server` 的装配层（`cmd/dialectcheck` 的允许清
单里就这一处），所以子命令的方言判断写在 `cmd/server/db_backup.go`，而不是新
建一个 `cmd/db` 包——后者会让方言分支出现在第二个地方。

### 子命令错误不套 `startup failed` 前缀

`main.go` 原本把所有错误都包成 `wmind startup failed: %v`。对
`wmind db` 的用法错误来说这个前缀是误导（它压根没打算启动）。加了一个
`errAlreadyReported` 哨兵：子命令自己打印 `wmind: <err>`，`main` 看到哨兵就
不再二次包装、也不再打日志。

### 脚本先校验参数与配置，再检查环境

初版把 `command -v docker` 放在驱动名校验之前，于是 `WMIND_DB_DRIVER=mysql`
在有 Docker 的机器上报「驱动名非法」，在没有 Docker 的机器上报「找不到
docker」。参数错了就该直说参数错了，所以顺序改成：参数 → 文件存在性 → 驱动名
→ docker。

### 备份的三个防「静默空备份」措施

1. `BACKUP_DIR` **先 `cd` 进目录再 `pwd` 取绝对路径**，再传给 `-v`；
2. 上传文件备份前先 `docker volume inspect`，卷不存在就明确警告并跳过，而不是
   打一个空包；
3. SQLite 先 `VACUUM INTO` 到容器内 `/data/.backup-<stamp>.db`，再
   `compose cp` 出来，最后删临时文件——不直接对宿主机路径写，也不在写入过程中
   被 `cp` 读到半成品。

清理只删 `wmind-*` 前缀，`KEEP_DAYS` 可配（默认 30），所以不需要另写一条
cron。

### 恢复的顺序与两处「会删掉数据库」的坑

SQLite 恢复用一次性 alpine 容器，顺序固定为
`mv 旧库 → rm -f -wal/-shm → cp → chown 10001:10001`：

- **先改名保留**（`wmind.db.before-restore`）：恢复本身也可能恢复出一个坏库，
  留着旧文件才有第二条退路；
- **必须删 `-wal`/`-shm`**：它们属于旧库，留着会让 SQLite 拒绝打开新库或静默
  丢弃已提交数据；
- **必须 `chown 10001`**：`cp` 出来的文件属主是 root，不 chown 则 api 启动后
  报 `attempt to write a readonly database`；
- **上传文件的目标是 `/data/uploads`，不是卷根 `/data`**：SQLite 部署里数据库
  和上传文件共用 `data` 卷，对卷根 `rm -rf` 会把刚恢复好的数据库一起删掉。这
  是整件事里最容易犯、后果最重的一个错。

`--with-env` 只在显式要求时备份 `.env`，用 `install -m 600`，并打印一行警告说
它含 JWT 密钥与数据库密码。默认不备：把它和数据库放进同一个未加密归档，等于
把钥匙和锁放在一起。

### 脚本可读自己的头部注释

`--help` 要打印文件头部注释，但脚本会先 `cd` 到 `deploy/`，之后
`${BASH_SOURCE[0]}` 的相对路径就失效了（`sed: ./deploy/scripts/backup.sh: No
such file or directory`）。所以先算出绝对 `SCRIPT_PATH` 再 `cd`。

打印时用 `awk 'NR<3{next} /^#/{sub(/^# ?/,"");print;next} {exit}'`，而不是写死
行号范围——写死的话改注释就会漏出后面的 `set -euo pipefail`（初版就是这样，
帮助文本末尾多了一行）。

## Consequences

- **备份产物有三件而不是两件**：数据库、上传文件、可选 `.env`。恢复时三者的
  目标位置都不同（见上），文档 §7.2 用一张表列清楚。
- **恢复是破坏性的，必须交互确认**。`FORCE=1` 供自动化使用，脚本不猜。
- **`.before-restore` 会一直留在卷里**，占一份数据库大小的空间。这是刻意的：
  自动清理它等于取消了第二条退路。运维确认无误后手动删。
- **`db backup` 的方言检查意味着 PostgreSQL 部署不能用它**，脚本在 postgres
  分支走 `pg_dump`，两套机制无法统一成一条命令。
- **恢复后所有会话仍然有效**（`.env` 里的 `WMIND_JWT_SECRET` 没变），但若恢复
  到另一台机器且没带 `.env`，所有人会被强制登出。
- 完整的 docker 编排路径**没有在本机跑通**（开发机没有 Docker）。已验证的是：
  `bash -n`、全部参数/文件/驱动校验分支、以及恢复流程里两段一次性容器命令在临
  时目录里的原样执行。真实演练需要在有 Docker 的环境或 CI 里补。

2FA 加密密钥也必须随配置加密备份：优先 WMIND_2FA_ENCRYPTION_KEY，未设置时使用 JWT 密钥的用途隔离派生。换密钥不能恢复原验证器密钥；保留恢复码的用户仍可登录后重新登记。数据库快照自动包含 user_two_factor，环境密钥仍由 --with-env 或独立密钥管理保管。

## Alternatives considered

- **`cp /data/wmind.db`**：WAL 模式下会丢最近的提交，运行中拷还可能拿到损坏
  文件。直接排除。
- **镜像里装 `sqlite3`，用 `.backup`**：多一个依赖，且要跟随 alpine 的包版本；
  `VACUUM INTO` 在服务内就能做，没有理由引入外部工具。
- **备份前 `stop api`**：能得到最简单的文件级一致性，但每天凌晨停一次服务不可
  接受。`VACUUM INTO` 与 `pg_dump` 都是在线一致的。
- **恢复直接覆盖，不做 `.before-restore`**：省一步，但恢复失败时没有任何退路。
  保留旧文件的空间成本远低于一次误操作。
- **把上传文件和数据库打进同一个 tar**：少一个文件，但恢复时无法只换其中一
  个；而且 SQLite 部署里两者同卷，打包会重复包含数据库。
- **新开 `cmd/db` 包做子命令**：会让方言分支出现在 `cmd/server` 之外，违反
  `dialectcheck` 的边界。
- **`--help` 用写死的行号范围**：初版就是这么写的，改一次注释就漏行。改成读到
  第一个非注释行为止。

后台自动备份使用独立的 [ZIP 归档协议](2026-10-24-wmind-backup-archive.md)，不替代本文 CLI 与部署脚本的物理快照和分离恢复语义。
