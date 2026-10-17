// Package sqlite 提供 SQLite 方言的连接初始化与仓储实现。
//
// 本包是方言落点白名单中的第 1、2、6 项所在处（连接装配 / 事务管理器 / 启动自检）。
// 除此之外，SQLite 与 PostgreSQL 的差异都应留在 db/queries 的查询文件里。
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	// 纯 Go 驱动。选它而不是 mattn/go-sqlite3，是为了保住
	// CGO_ENABLED=0 的静态构建（见 ADR-015 的被否方案）。
	_ "modernc.org/sqlite"
)

// pragmas 是连接级必需设置，五项缺一不可（见 docs/03 §3.4.1）。
//
// 通过 DSN 的 _pragma 参数下发，而不是连接后逐条 Exec：连接池会建立多条连接，
// 逐条 Exec 只作用于当时那一条，池里其它连接仍是默认配置——这是很难复现的
// 间歇性 bug 来源。
var pragmas = []string{
	// 单写多读；默认的 delete 模式下读会被写阻塞。
	"_pragma=journal_mode(WAL)",
	// 遇锁等待 5 秒而不是立刻返回 SQLITE_BUSY。
	"_pragma=busy_timeout(5000)",
	// SQLite **默认关闭**外键约束，不显式打开则所有 REFERENCES 形同虚设。
	"_pragma=foreign_keys(ON)",
	// WAL 下 NORMAL 已能保证崩溃一致性，FULL 会显著拖慢写入。
	"_pragma=synchronous(NORMAL)",
	// 排序与临时表走内存。
	"_pragma=temp_store(MEMORY)",
}

// Open 打开（必要时创建）SQLite 数据库并完成连接级初始化。
//
// 传 ":memory:" 时走内存库，供测试使用。
func Open(path string) (*sql.DB, error) {
	if path != ":memory:" {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			// 0750：数据库目录含用户数据，不需要对同组以外开放。
			if err := os.MkdirAll(dir, 0o750); err != nil {
				return nil, fmt.Errorf("创建数据库目录 %s 失败: %w", dir, err)
			}
		}
	}

	dsn := "file:" + path + "?" + strings.Join(pragmas, "&")
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 失败: %w", err)
	}

	// SQLite 同一时刻只允许一个写者。单连接池从根本上消除 SQLITE_BUSY 与
	// "database is locked"。代价是读也串行化——在 10~100 人、单实例的规模下
	// 不可感知（见 docs/03 §3.4.2）。
	//
	// 升级路径（二期可选）：一个 MaxOpenConns(1) 的写池 + 一个 MaxOpenConns(N)
	// 的只读池，读写分离。需要多一套连接管理与「哪些查询走只读池」的判定。
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0) // 单连接常驻，不主动回收

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("连接 SQLite 失败: %w", err)
	}
	return db, nil
}

// Check 构造就绪探针的检查函数。
//
// 做两件事：`PRAGMA quick_check` 确认文件结构完好，再取一次写锁确认库可写。
// 第二项是必要的——「可读但不可写」是 SQLite 最典型的故障形态（卷只读、
// 权限错、磁盘满），而只做 SELECT 的探针会一路返回健康，直到用户保存失败。
func Check(db *sql.DB) func(ctx context.Context) error {
	return func(ctx context.Context) error {
		var result string
		if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil {
			return fmt.Errorf("quick_check 执行失败: %w", err)
		}
		if result != "ok" {
			return fmt.Errorf("quick_check 报告数据库异常: %s", result)
		}

		// 写探测：把 user_version 原值写回。它落在数据库头部，是一次真实的
		// 写操作，但**不改变任何数据**，也不会触碰 schema（用建临时表做探测
		// 会让表结构随探针出现又消失，干扰 introspect 比对）。
		var version int
		if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
			return fmt.Errorf("读取 user_version 失败: %w", err)
		}
		if _, err := db.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
			return fmt.Errorf("数据库不可写: %w", err)
		}
		return nil
	}
}
