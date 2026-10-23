# Agent Note: M0 交付闸门：CI 只跑一条流水线，部署模板不在本机验证

Status: implemented

## Problem

M0 收尾要把「代码能跑」变成「每次提交都能证明代码还能跑」。约束有三个：

- 本机没有 Docker，`docker compose config` 与镜像构建在本机跑不了。
- 双方言仓储的 PostgreSQL 分支需要真实 PG 实例，本机没有。
- 前端依赖在本机的 pnpm store 里解包不全（`lucide-react` 等包只剩 `package.json`），`pnpm install` 反复失败。

如果按「本地全绿才提交」的直觉走，这三件事会把 M0 卡死；如果按「先提交，CI 再说」走，闸门形同虚设——第一次红就没人再看。真正要定的是：**哪些验证必须在本机过，哪些交给 CI，以及 CI 里各道闸门的顺序。**

## Decision

触发与发布规则由[版本标签发布](2026-10-24-wmind-tag-release.md)部分取代；本篇保留本机与 CI 的验证边界及原有质量闸门理由。

PostgreSQL 迁移连接的释放边界见[迁移连接占用修复](../bug-fix/2026-10-24-wmind-parity-migration-connection.md)，防止单连接验证池在结构内省前等待自己持有的迁移连接。

### 本机必须过的四件事

1. `cd backend && go test ./... && go vet ./...`——SQLite 分支的集成测试在本机全跑，不需要任何外部服务。
2. `cd frontend && tsc --noEmit && vitest run && vite build`——类型、单测、生产构建三件套。
3. `npm run verify-notes` 与 `make verify-dialect`（迁移 parity + 方言泄漏检查）。
4. `git diff --check`。

**部署模板（Compose / Dockerfile / Nginx）不在本机验证**，只做静态解析（YAML 能否 load、环境变量是否齐全）。理由：本机没有 Docker，任何「看起来跑通了」的替代验证都会给出假信号。

### CI 是唯一跑全量的地方

`.github/workflows/ci.yml` 单 job 顺序执行，顺序按「越便宜越靠前、越可能红越靠前」排：

1. `sqlc generate` + `git diff --exit-code`——生成代码与 SQL 不同步是最常见的漂移，必须第一个红。
2. `npm run verify-notes`——纯文本检查，秒级。
3. `go run ./cmd/dialectcheck .`——方言是否泄漏进 service/handler。
4. `go run ./cmd/verifyparity`——两套迁移集结构比对（**必须**有 `WMIND_TEST_DATABASE_URL`，否则只比 SQLite 侧，闸门静默半开）。
5. `go test ./...` / `go vet ./...`。
6. 前端 `typecheck && test && build`。
7. `docker compose config` + 两次 `docker build`。

CI 里 PostgreSQL 由 service container 提供，`WMIND_TEST_DATABASE_URL` 显式注入——这就是本机跑不到的那半边。

### 部署模板的两个硬约束

- 两套 Compose 的 `build.context` 都是仓库根（`..`），Dockerfile 在 `deploy/` 下，靠仓库根 `.dockerignore` 排除 `node_modules`、`dist`、`.env`、`*.db`。镜像构建与本地目录布局解耦。
- `WMIND_JWT_SECRET` 与 `POSTGRES_PASSWORD` 用 `${VAR:?}` 语法**强制**外部注入：缺变量时 `docker compose config` 直接失败，而不是起一个用默认密钥的服务。CI 里对应两个假值，仅为让 `config` 通过。

## Alternatives considered

- **在本机装 Docker 再验证部署模板** — 最忠实。被否是因为这会把「M0 能否交付」绑在一台开发机的软件安装上；CI 的 `docker build` 本来就是同一件事，且每次提交都跑。
- **用 `podman` / `nerdctl` 顶替 Docker 验证 Compose** — 能跑一部分。被否是因为 Compose 语义（`depends_on: condition: service_healthy`、volume 命名）在替代实现上行为不完全一致，验证通过不代表 Docker 上通过，属于假信号。
- **本机起一个 PostgreSQL 容器做 parity 比对** — 同样卡在没有 Docker。改为：本机跑 SQLite 侧并在输出里**显式提示**「未设置 `WMIND_TEST_DATABASE_URL`，已跳过 PostgreSQL 结构比对」，让「半开闸门」在日志里可见，而不是静默通过。
- **CI 拆成 backend / frontend / deploy 三个并行 job** — 更快。被否是因为 M0 阶段总时长不到十分钟，拆 job 换来的是三份重复的 checkout 与依赖安装，以及「哪个 job 是权威」的歧义。等时长真的成为问题时再拆。
- **前端继续用 `lucide-react`，把依赖问题留给 CI 解决** — 见 [frontend icon set](../architecture/2026-10-17-wmind-frontend-icon-set.md)：依赖在本机不可解包，本地就无法构建，等于放弃了第 2 条本机闸门。

## Consequences

- **收益**：本机四条闸门全部可离线执行，提交前就能拦住绝大多数红；CI 负责 Docker 与 PostgreSQL 这两块本机确实没有的能力。
- **收益**：`${VAR:?}` 让「忘了配密钥」在 `docker compose config` 阶段暴露，而不是在运行期。
- **代价**：部署模板的正确性依赖 CI 反馈，本地改完 Compose 无法即时验证，一轮反馈要等 CI 跑完。
- **代价**：`verifyparity` 在本机是半开状态（只验 SQLite），必须靠 CI 补齐；这是已知缺口，输出里已显式提示。
- **已知上限**：CI 用 `go-version-file: backend/go.mod` 与 `pnpm-lock.yaml` 的 `--frozen-lockfile` 锁版本。锁文件与 `package.json` 不同步时 CI 会红——这是有意的，本地改依赖后必须刷新锁文件。

## Verification

- 本机：`go test ./...`、`go vet ./...`、`tsc --noEmit`、`vitest run`（5 项）、`vite build`、`npm run verify-notes`、`make verify-dialect`、`git diff --check` 全绿。
- 生产模式冒烟：以 `WMIND_ENV=production` + `WMIND_AUTO_MIGRATE=true` 启动静态二进制，`/api/v1/health/live` 与 `/api/v1/health/ready` 均 200，`checks.database` 为 `ok`，收到信号后优雅退出。
- 部署模板：两套 Compose 与 CI YAML 静态解析通过；镜像构建与 `docker compose config` 由 CI 执行。
