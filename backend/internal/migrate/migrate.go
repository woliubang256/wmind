// Package migrate 执行数据库迁移。
//
// 本包持有方言落点白名单的第 1 项（连接与迁移装配）。它出现的这个 switch
// 是**允许**的：迁移源（哪套 SQL）与驱动注册方式天然不同。除此之外，
// service 与 handler 层不应出现任何方言判断。
package migrate

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database"
	pgxmigrate "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/woliubang256/wmind/backend/db/migrations"
	"github.com/woliubang256/wmind/backend/internal/config"
)

// Up 把指定方言的迁移集推进到最新版本。
//
// 两个驱动分别注册：PostgreSQL 用 database/pgx/v5，SQLite 用 database/sqlite
// ——后者底层是 modernc.org/sqlite（纯 Go），因此不会破坏 CGO_ENABLED=0 的
// 静态构建。这一点是选型时刻意确认过的，不是巧合。
//
// 已经是最新版本时返回 nil（golang-migrate 用 ErrNoChange 表达，不算错误）。
func Up(driver string, db *sql.DB, log *slog.Logger) error {
	var (
		src      source.Driver
		dbDriver database.Driver
		err      error
	)

	switch driver {
	case config.DriverSQLite:
		if src, err = iofs.New(migrations.SQLiteFS, "sqlite"); err != nil {
			return fmt.Errorf("加载 SQLite 迁移集失败: %w", err)
		}
		if dbDriver, err = sqlitemigrate.WithInstance(db, &sqlitemigrate.Config{}); err != nil {
			return fmt.Errorf("初始化 SQLite 迁移驱动失败: %w", err)
		}
	case config.DriverPostgres:
		if src, err = iofs.New(migrations.PostgresFS, "postgres"); err != nil {
			return fmt.Errorf("加载 PostgreSQL 迁移集失败: %w", err)
		}
		if dbDriver, err = pgxmigrate.WithInstance(db, &pgxmigrate.Config{}); err != nil {
			return fmt.Errorf("初始化 PostgreSQL 迁移驱动失败: %w", err)
		}
	default:
		return fmt.Errorf("未知数据库驱动 %q", driver)
	}

	m, err := migrate.NewWithInstance("iofs", src, driver, dbDriver)
	if err != nil {
		return fmt.Errorf("创建迁移器失败: %w", err)
	}

	// ⚠️ 故意不调用 m.Close()。
	//
	// golang-migrate 的 Close() 会同时关闭 source 与 database 两个驱动，而
	// database 驱动的 Close() 会**关掉传进来的那个 *sql.DB**。调用方（main）
	// 迁移之后还要继续用同一个连接，Close 掉会让后续所有查询报
	// "sql: database is closed"——错误信息完全指不到迁移这一步。
	//
	// 代价是 iofs source 不被释放。它只持有内存中的 embed.FS，进程生命周期内
	// 迁移只跑一次，不构成泄漏。
	//
	// 若将来需要释放，正确做法是让 Up 自己开一条专用连接并在用完后关闭，
	// 而不是在这里调用 Close()。

	before, dirty, err := m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		return fmt.Errorf("读取当前迁移版本失败: %w", err)
	}
	if dirty {
		// dirty 表示上一次迁移中途失败，schema 处于未知状态。
		// 继续跑只会把问题叠得更深，必须人工介入。
		return fmt.Errorf("数据库处于 dirty 状态（版本 %d），需人工检查后修复 schema_migrations 表", before)
	}

	if err := m.Up(); err != nil {
		if errors.Is(err, migrate.ErrNoChange) {
			log.Info("数据库结构已是最新", "driver", driver, "version", before)
			return nil
		}
		return fmt.Errorf("执行迁移失败: %w", err)
	}

	after, _, err := m.Version()
	if err != nil {
		return fmt.Errorf("读取迁移后版本失败: %w", err)
	}
	log.Info("数据库迁移完成", "driver", driver, "from", before, "to", after)
	return nil
}
