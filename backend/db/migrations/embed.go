// Package migrations 把两套迁移集编进二进制。
//
// 为什么用 embed 而不是读文件系统：容器镜像里不需要额外拷贝 SQL 文件，
// `docker cp` 调试、从任意工作目录启动都不会因为找不到迁移目录而失败。
// 两个方言各暴露一个 FS，由 internal/migrate 按驱动选择。
package migrations

import "embed"

// PostgresFS 是 PostgreSQL 迁移集。
//
//go:embed postgres/*.sql
var PostgresFS embed.FS

// SQLiteFS 是 SQLite 迁移集。
//
//go:embed sqlite/*.sql
var SQLiteFS embed.FS
