# wmind

可自托管的思维导图系统。对标 XMind 的编辑体验，一条命令私有化部署。

| | |
| --- | --- |
| 后端 | Go 1.25 + Gin，模块化单体；**SQLite（默认）与 PostgreSQL 双方言** |
| 前端 | React + TypeScript + Vite + shadcn/ui，纯 SPA，自带暗色模式 |
| 编辑器 | 自研 SVG 渲染 + 自研布局引擎（8 种结构、10 套配色） |
| 格式 | 自有 `.wmind` 文档格式；导入 XMind / Markdown / OPML，导出 PNG / JPEG / SVG / PDF / Markdown / OPML |
| 部署 | `docker compose up -d`，一期零外部依赖 |

需求、架构、接口、部署的完整设计见 [`docs/`](./docs/README.md)。

## 当前状态

**M0 工程脚手架进行中，尚无可用界面。**

| 模块 | 状态 |
| --- | --- |
| 文档与架构决策 | ✅ v1.3 定稿 |
| 后端骨架（配置 / 日志 / 统一响应 / 健康检查 / 中间件 / 优雅退出） | ✅ 已完成 |
| 数据库双方言基建（两套迁移集 / sqlc 双 target / 双方言仓储） | ⬜ 进行中 |
| 前端骨架 | ⬜ 未开始 |
| 部署编排与 CI | ⬜ 未开始 |

## 快速开始

### 后端（本地开发，不需要 Docker）

默认使用 SQLite——数据库就是一个文件，**不需要启动任何数据库服务**。

```bash
cd backend
cp .env.example .env
# 填好 WMIND_JWT_SECRET（必须 ≥ 32 字节）：
#   openssl rand -base64 48
go run ./cmd/server
```

服务监听 `:8080`。验证：

```bash
curl -s http://localhost:8080/api/v1/health/ready
# {"data":{"checks":{},"status":"ok"},"requestId":"01J..."}
```

改用 PostgreSQL 只需两个环境变量，代码与其它配置完全不变：

```bash
WMIND_DB_DRIVER=postgres \
WMIND_DATABASE_URL='postgres://wmind:wmind@localhost:5432/wmind?sslmode=disable' \
go run ./cmd/server
```

### 部署

```bash
cd deploy
cp .env.example .env          # 填好 WMIND_JWT_SECRET
docker compose up -d          # 默认 SQLite，两个容器
```

需要 PostgreSQL 时换一套编排：

```bash
docker compose -f docker-compose.postgres.yml up -d
```

> 部署编排在 M0 后期补齐，当前尚未提交。

## 常用命令

```bash
make help            # 列出全部命令
make dev-backend     # 本地启动后端
make test            # 后端全部测试
make lint            # go vet + gofmt
make verify-notes    # 校验架构决策笔记
```

## 目录结构

```
wmind/
├── backend/                  Go 后端（模块 github.com/woliubang256/wmind/backend）
│   ├── cmd/server/           入口：装配依赖、启动、优雅退出
│   ├── internal/
│   │   ├── config/           配置加载与校验
│   │   ├── httpapi/          路由、中间件、统一响应信封
│   │   ├── handler/          请求解析与响应组装（不含业务规则）
│   │   ├── service/          业务规则与事务边界（方言无关）
│   │   ├── repository/       postgres/ 与 sqlite/ 两套方言实现
│   │   ├── domain/           领域模型与仓储接口（方言无关）
│   │   ├── docmodel/         .wmind 文档模型
│   │   ├── convert/          导入导出适配器
│   │   └── pkg/              apperr / logger / id / reqid 等通用件
│   └── db/                   两套迁移集、sqlc 配置与查询
├── frontend/                 React 前端（M0 后期建立）
├── deploy/                   Compose、Dockerfile、Nginx 配置
├── docs/                     需求、架构、接口、部署文档
└── .agents/                  架构决策笔记与校验脚本
```

## 两个数据库方言

由 `WMIND_DB_DRIVER` 选择（`sqlite` 默认 / `postgres`）。**业务代码对两者完全无感**——
service 与 handler 层只依赖 `domain` 中的接口，唯一的方言分叉在 `cmd/server` 的装配处，
由静态检查兜底。详见 [docs/09-技术决策记录.md](./docs/09-技术决策记录.md) 的 ADR-015。

两条容易踩的边界：

- **SQLite 只能单实例运行**，且数据库文件必须放在本地块设备卷上（不支持 NFS / 云盘）。
- **切换驱动不会搬运数据**。改 `WMIND_DB_DRIVER` 只是换了连接目标，既有数据仍留在原库；
  跨方言迁移需逐图导出 `.wmind` 手工完成，工具在二期。

## 开发约定

- 提交信息遵循 Conventional Commits，冒号后用中文一句话说明，如 `feat(editor): 支持拖拽调整分支顺序`。
- 非平凡改动（行为、架构、跨文件契约、工具链、测试策略、落盘格式）必须同批提交一篇
  架构决策笔记到 `.agents/notes/`，规则见 [`.agents/skills/write-notes-like-deepseek/SKILL.md`](./.agents/skills/write-notes-like-deepseek/SKILL.md)。
- 提交前跑 `make verify-notes` 与 `make test`。

## 许可

[MIT](./LICENSE)
