// Package postgres 提供 PostgreSQL 方言的连接初始化与仓储实现。
package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	// pgx 的 database/sql 适配层。仅用于两处：golang-migrate 需要一个
	// *sql.DB 来执行迁移；以及 parity 校验需要 introspect。
	// 业务查询走 pgxpool，不走这里。
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect 建立 PostgreSQL 连接池。
//
// 与 SQLite 侧的 Open 相对应：两个函数签名不同、返回值类型也不同，
// 但**调用它们的地方是同一个 switch**，上层看不到差异。
func Connect(ctx context.Context, url string, maxConns int) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("解析 WMIND_DATABASE_URL 失败: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = int32(maxConns)
	}
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 30 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("创建 PostgreSQL 连接池失败: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("连接 PostgreSQL 失败: %w", err)
	}
	return pool, nil
}

// OpenForMigration 打开一条供迁移使用的 database/sql 连接。
//
// 单独开而不是复用 pgxpool：golang-migrate 的 pgx/v5 驱动要的是 *sql.DB，
// 而 pgxpool 的连接类型不兼容。迁移只在启动时跑一次，用完即关，
// 多一条连接的成本可以忽略。
func OpenForMigration(url string) (*sql.DB, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("打开迁移连接失败: %w", err)
	}
	// 迁移是串行的，多连接没有意义，反而可能让 DDL 并发执行。
	db.SetMaxOpenConns(1)
	return db, nil
}

// Check 构造就绪探针的检查函数。
//
// PostgreSQL 侧只需一次 SELECT 1：可读即代表连接池可用，而 PG 不会出现
// 「可读但不可写」这种 SQLite 特有的降级形态。
func Check(pool *pgxpool.Pool) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		var one int
		if err := pool.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
			return fmt.Errorf("SELECT 1 失败: %w", err)
		}
		return nil
	}
}
