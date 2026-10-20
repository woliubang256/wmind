package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/config"
	sqliterepo "github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// seedSQLite 建一个可备份的库。
func seedSQLite(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "wmind.db")
	db, err := sqliterepo.Open(path)
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("关闭测试库失败: %v", err)
	}
	return path
}

func TestRunDBSubcommandIgnoresNonSubcommand(t *testing.T) {
	cfg := &config.Config{DB: config.DB{Driver: config.DriverSQLite, SQLitePath: seedSQLite(t)}}

	// 没有参数、以及常见的启动参数，都必须交回给 HTTP 服务那条路。
	for _, args := range [][]string{nil, {}, {"serve"}, {"--help"}} {
		handled, err := runDBSubcommand(context.Background(), cfg, args, quietLogger())
		if handled || err != nil {
			t.Fatalf("args=%v 不该被当成子命令：handled=%v err=%v", args, handled, err)
		}
	}
}

func TestRunDBSubcommandBackupWritesFile(t *testing.T) {
	dbPath := seedSQLite(t)
	cfg := &config.Config{DB: config.DB{Driver: config.DriverSQLite, SQLitePath: dbPath}}
	out := filepath.Join(t.TempDir(), "manual.db")

	handled, err := runDBSubcommand(context.Background(), cfg, []string{"db", "backup", "--out", out}, quietLogger())
	if !handled {
		t.Fatal("db backup 应当被识别为子命令")
	}
	if err != nil {
		t.Fatalf("备份失败: %v", err)
	}
	if _, statErr := os.Stat(out); statErr != nil {
		t.Fatalf("备份文件不存在: %v", statErr)
	}
}

func TestRunDBBackupDefaultTargetSitsNextToDatabase(t *testing.T) {
	dbPath := seedSQLite(t)
	cfg := &config.Config{DB: config.DB{Driver: config.DriverSQLite, SQLitePath: dbPath}}

	handled, err := runDBSubcommand(context.Background(), cfg, []string{"db", "backup"}, quietLogger())
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}

	entries, readErr := os.ReadDir(filepath.Dir(dbPath))
	if readErr != nil {
		t.Fatalf("读目录失败: %v", readErr)
	}
	var found bool
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "wmind-backup-") && strings.HasSuffix(entry.Name(), ".db") {
			found = true
		}
	}
	if !found {
		t.Fatalf("没有在库同目录生成默认命名的备份：%v", entries)
	}
}

func TestRunDBBackupRejectsPostgres(t *testing.T) {
	cfg := &config.Config{DB: config.DB{Driver: config.DriverPostgres, URL: "postgres://x"}}

	handled, err := runDBSubcommand(context.Background(), cfg, []string{"db", "backup", "--out", "/tmp/x.dump"}, quietLogger())
	if !handled {
		t.Fatal("应当识别为子命令")
	}
	if err == nil {
		t.Fatal("PostgreSQL 上应当拒绝，并提示改用 pg_dump")
	}
	if !strings.Contains(err.Error(), "pg_dump") {
		t.Fatalf("错误信息应指向 pg_dump，实际: %v", err)
	}
}

func TestRunDBSubcommandUsageErrors(t *testing.T) {
	cfg := &config.Config{DB: config.DB{Driver: config.DriverSQLite, SQLitePath: seedSQLite(t)}}

	cases := []struct {
		name string
		args []string
		want string
	}{
		{"缺少子命令", []string{"db"}, "缺少 db 子命令"},
		{"未知子命令", []string{"db", "restore"}, "未知的 db 子命令"},
		{"多余参数", []string{"db", "backup", "extra"}, "多余的参数"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handled, err := runDBSubcommand(context.Background(), cfg, tc.args, quietLogger())
			if !handled || err == nil {
				t.Fatalf("handled=%v err=%v", handled, err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("错误信息应包含 %q，实际: %v", tc.want, err)
			}
		})
	}
}
