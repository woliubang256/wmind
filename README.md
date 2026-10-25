# wmind

可自托管的在线思维导图工具，用于整理知识、梳理项目和分享想法。支持 Docker Compose 部署，数据由自己掌握。

[快速部署](#部署) · [使用手册](./docs/10-用户使用手册.md) · [部署指南](./docs/07-部署与运维.md) · [开发文档](./docs/README.md)

## 主要功能

- **导图编辑**：快捷键、拖拽、撤销重做与自动保存，支持概要、边界、联系线、备注、标签和附件。
- **布局与外观**：9 种布局结构、19 套内置配色和自定义主题，支持浅色 / 深色模式与中英文切换。
- **多画布与大纲**：一份文档管理多个画布，随时切换大纲视图，支持 ZEN 专注模式与模板复用。
- **导入与导出**：导入 XMind / Markdown / OPML，导出 JPEG / PNG / SVG / PDF / XMind / Markdown / OPML，也可保存为 `.wmind` 文档。
- **AI 生成**：组合文字、Word、Excel、PDF 和图片生成可编辑导图，支持多文件拖拽上传。
- **链接分享**：设置有效期、访问密码、下载与备注权限，访客可缩放画布、折叠和展开节点。
- **私有部署与管理**：支持 SQLite / PostgreSQL、用户管理与双因素认证，提供 S3 / WebDAV 备份恢复、定时备份、保留份数和可选去重。

PDF 导出为单页图片，文字不可选中。

AI 功能默认关闭，在「网站设置 → AI」配置 OpenAI 兼容 Provider 的 Base URL、API Key、Model 并启用；思考等级可选，默认不传。支持 `.docx`、`.xlsx`，图片与扫描 PDF 需要视觉模型；素材会发送给所配置的 Provider。详细说明见[使用手册](./docs/10-用户使用手册.md#ai-生成)。

## 界面预览

### 导图编辑

![wmind 编辑器：产品规划导图、配色面板与多画布](./docs/screenshots/editor.png)

### 链接分享

![wmind 分享页：只读导图、画布切换与缩放控件](./docs/screenshots/share.png)

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 后端 | Go 1.25 + Gin，模块化单体 |
| 前端 | React + TypeScript + Vite + Tailwind CSS v4，纯 SPA |
| 编辑器 | 自研 SVG 渲染与布局引擎 |
| 数据库 | SQLite（默认）/ PostgreSQL |
| 部署 | Docker Compose，支持 amd64 / arm64 |

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

### 前端（本地开发）

```bash
cd frontend
pnpm install
pnpm dev            # http://127.0.0.1:5173
```

Vite 开发服务器把 `/api` 代理到 `http://127.0.0.1:8080`，浏览器里是同源请求，不受 CORS 限制。

### 首次登录

`users` 表为空时，后端用 `WMIND_ADMIN_EMAIL` / `WMIND_ADMIN_PASSWORD` 创建第一个管理员（示例值 `admin@wmind.local` / `change-me-please`）。**登录后请立刻在「个人设置 → 修改密码」改掉**，生产环境不要沿用示例值。

管理员登录后侧栏会出现「管理概览 / 用户管理 / 网站设置」。一期没有自助找回密码：由管理员在「用户管理」里重置，新密码**只显示一次**。

### 部署

```bash
cd deploy
cp .env.example .env          # 填好 WMIND_JWT_SECRET
docker compose pull           # 拉取发布镜像（私有包需先 docker login ghcr.io）
docker compose up -d --no-build # 默认 SQLite，两个容器
```

需要 PostgreSQL 时换一套编排：

```bash
docker compose -f docker-compose.postgres.yml pull
docker compose -f docker-compose.postgres.yml up -d --no-build
```

> 本项目 SQLite 形态为单 API 实例，数据库卷必须使用本地存储；PostgreSQL 形态可扩展 API 实例。切换数据库驱动不会迁移现有数据。

## 开发与发布

版本发布、常用命令、目录结构、数据库方言与开发约定见[开发指南](./docs/development.md)。

## 许可

[MIT](./LICENSE)

## 社区

[Linux DO](https://linux.do/)
