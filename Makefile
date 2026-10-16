# wmind — 常用开发命令
#
# 本机没有 Docker 也能完整开发：默认数据库是 SQLite，就是一个文件。

SHELL := /bin/bash
.DEFAULT_GOAL := help

BACKEND  := backend
FRONTEND := frontend

.PHONY: help
help: ## 显示本帮助
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── 开发 ─────────────────────────────────────────────

.PHONY: dev-backend
dev-backend: ## 本地启动后端（SQLite，:8080）
	cd $(BACKEND) && go run ./cmd/server

.PHONY: dev-frontend
dev-frontend: ## 本地启动前端（Vite，:5173）
	cd $(FRONTEND) && pnpm dev

# ── 构建与检查 ───────────────────────────────────────

.PHONY: build
build: ## 构建后端静态二进制到 backend/bin/
	cd $(BACKEND) && CGO_ENABLED=0 go build -trimpath -o bin/wmind-server ./cmd/server

.PHONY: test
test: ## 跑后端全部测试（SQLite 集成测试不需要 Docker）
	cd $(BACKEND) && go test ./...

.PHONY: lint
lint: ## 后端 go vet + gofmt 检查
	cd $(BACKEND) && go vet ./... && test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

# ── 数据库 ───────────────────────────────────────────

.PHONY: sqlc
sqlc: ## 重新生成双 target 的 sqlc 代码（pgdb / sqlitedb）
	cd $(BACKEND) && sqlc generate

.PHONY: verify-parity
verify-parity: ## 校验两套迁移集结构一致（CI 必过闸门）
	cd $(BACKEND) && go run ./cmd/verifyparity

# ── 笔记 ─────────────────────────────────────────────

.PHONY: verify-notes
verify-notes: ## 校验架构决策笔记（树/格式/归档封印）
	npm run verify-notes
