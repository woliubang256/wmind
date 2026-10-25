# 开发与发布

本地启动与部署入口见[项目 README](../README.md#快速开始)，完整设计文档见[文档索引](./README.md)。以下命令默认在仓库根目录执行。

## 版本与发布

正式版本以根目录 [VERSION](../VERSION) 为准，个人设置入口右侧显示正在运行的后端版本；直接 `go run` 的开发服务显示 `dev`。部署时在 `deploy/.env` 设置 `WMIND_VERSION=v1.0.0` 可固定版本；留为 `latest` 则拉取最新正式镜像。源码本地构建使用 `docker compose up -d --build`。

普通提交和 PR 不触发 CI，推送 `v*` 标签才执行完整校验、构建并发布 GitHub Release。发布页包含自动分类的更新日志、Linux amd64/arm64 部署压缩包、SHA256SUMS，以及对应的 GHCR API/Web 多架构镜像。压缩包只包含二进制、静态前端、示例配置与部署脚本，使用方式见包内 RELEASE.md；解压前可执行 `sha256sum -c SHA256SUMS` 校验。

```bash
npm run version:next          # 同步 VERSION 和两个 package.json，不自动提交或打标签
npm run version:check -- v1.0.1
npm run test:release
# 提交本次版本变更并通过相关本地检查后：
git tag -a v1.0.1 -m "wmind v1.0.1"
git push origin main v1.0.1
```

版本按十进制进位：`1.0.8 → 1.0.9 → 1.1.0`，`1.9.9 → 2.0.0`。只有所有校验、压缩包和镜像都成功后才创建正式 Release；失败时修复问题并跟进流水线，不把仅创建标签当成已发布。

## 常用命令

```bash
make help            # 列出全部命令
make dev-backend     # 本地启动后端
make dev-frontend    # 本地启动前端
make test            # 后端全部测试（SQLite，不需要 Docker）
make test-frontend   # 前端类型检查 + 单测 + 生产构建
make lint            # go vet + gofmt
make verify-notes    # 校验架构决策笔记
make verify-dialect  # 迁移 parity + 方言分层检查
```

界面验收（需要后端与前端都起着，见 [`frontend/e2e/README.md`](../frontend/e2e/README.md)）：

```bash
cd frontend && npm run e2e
```

## 目录结构

```text
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
├── frontend/                 React 前端（Vite + TypeScript + Tailwind v4，自建 UI 组件）
│   └── e2e/                  界面验收脚本，见 e2e/README.md
├── deploy/                   Compose、Dockerfile、Nginx 配置
├── docs/                     需求、架构、接口、部署文档
└── .agents/                  架构决策笔记与校验脚本
```

## 两个数据库方言

由 `WMIND_DB_DRIVER` 选择（`sqlite` 默认 / `postgres`）。**业务代码对两者完全无感**——
service 与 handler 层只依赖 `domain` 中的接口，唯一的方言分叉在 `cmd/server` 的装配处，
由静态检查兜底。详见 [09-技术决策记录](./09-技术决策记录.md) 的 ADR-015。

两条容易踩的边界：

- **SQLite 只能单实例运行**，且数据库文件必须放在本地块设备卷上（不支持 NFS / 云盘）。
- **切换驱动不会搬运数据**。改 `WMIND_DB_DRIVER` 只是换了连接目标，既有数据仍留在原库；
  跨方言迁移需逐图导出 `.wmind` 手工完成，工具在二期。

## 开发约定

- 提交信息遵循 Conventional Commits，冒号后用中文一句话说明，如 `feat(editor): 支持拖拽调整分支顺序`。
- 非平凡改动（行为、架构、跨文件契约、工具链、测试策略、落盘格式）必须同批提交一篇
  架构决策笔记到 `.agents/notes/`，规则见 [`.agents/skills/write-notes-like-deepseek/SKILL.md`](../.agents/skills/write-notes-like-deepseek/SKILL.md)。
- 提交前跑 `make verify-notes` 与 `make test`。
