# wmind — 常用开发命令
#
# 本机没有 Docker 也能完整开发：默认数据库是 SQLite，就是一个文件。

SHELL := /bin/bash
.DEFAULT_GOAL := help

BACKEND  := backend
FRONTEND := frontend

# 版本号注入到 config.Version，由 GET /site/config 返回。
# VERSION 是发布元数据的唯一来源；可显式覆盖以构建测试版本。
VERSION ?= $(shell node scripts/release.mjs version)
LDFLAGS := -X github.com/woliubang256/wmind/backend/internal/config.Version=$(VERSION)

.PHONY: help
help: ## 显示本帮助
	@grep -hE '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) \
		| sed -E 's/^([a-zA-Z0-9_-]+):.*## /\1\t/' \
		| awk -F'\t' '{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── 开发 ─────────────────────────────────────────────

.PHONY: dev-backend
dev-backend: ## 本地启动后端（SQLite，:8080）
	cd $(BACKEND) && go run ./cmd/server

.PHONY: dev-frontend
dev-frontend: ## 本地启动前端（Vite，:5173）
	cd $(FRONTEND) && pnpm dev

.PHONY: test-frontend
test-frontend: ## 运行前端类型检查、单元测试与生产构建
	cd $(FRONTEND) && pnpm typecheck && pnpm test && pnpm build

# ── 构建与检查 ───────────────────────────────────────

.PHONY: build
build: ## 构建后端静态二进制到 backend/bin/
	cd $(BACKEND) && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/wmind-server ./cmd/server

.PHONY: test
test: ## 跑后端全部测试（SQLite 集成测试不需要 Docker）
	cd $(BACKEND) && go test ./...

.PHONY: lint
lint: ## 后端 go vet + gofmt 检查
	cd $(BACKEND) && go vet ./...
	@cd $(BACKEND) && unformatted=$$(gofmt -l .); \
		if [ -n "$$unformatted" ]; then echo "以下文件需要 gofmt："; echo "$$unformatted"; exit 1; fi

# ── 数据库 ───────────────────────────────────────────

.PHONY: sqlc
sqlc: ## 重新生成双 target 的 sqlc 代码（pgdb / sqlitedb）
	# 必须在 db/ 下跑：sqlc 只在当前目录找 sqlc.yaml，不会向上递归。
	cd $(BACKEND)/db && sqlc generate

.PHONY: verify-parity
verify-parity: ## 校验两套迁移集结构一致（CI 必过闸门）
	cd $(BACKEND) && go run ./cmd/verifyparity

.PHONY: verify-dialectcheck
verify-dialectcheck: ## 检查 service/handler 是否泄漏数据库方言
	cd $(BACKEND) && go run ./cmd/dialectcheck .

.PHONY: verify-dialect
verify-dialect: verify-parity verify-dialectcheck ## 运行双方言迁移与分层门禁

# ── 笔记 ─────────────────────────────────────────────

.PHONY: verify-notes
verify-notes: ## 校验架构决策笔记（树/格式/归档封印）
	npm run verify-notes
