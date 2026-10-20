package sqlite

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// openTemp 建一个带一行数据的库，返回库路径。
func openTemp(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "wmind.db")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO notes (body) VALUES (?)`, "备份里的这一行必须还在"); err != nil {
		t.Fatalf("插入失败: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("关闭测试库失败: %v", err)
	}
	return path
}

func TestBackupProducesReadableSnapshot(t *testing.T) {
	dbPath := openTemp(t)
	out := filepath.Join(t.TempDir(), "snap.db")

	if err := Backup(context.Background(), dbPath, out); err != nil {
		t.Fatalf("备份失败: %v", err)
	}

	info, err := os.Stat(out)
	if err != nil {
		t.Fatalf("备份文件不存在: %v", err)
	}
	if info.Size() == 0 {
		t.Fatal("备份文件为空")
	}

	// 真的打开备份读一遍：文件存在不等于能读，更不等于数据在。
	snap, err := Open(out)
	if err != nil {
		t.Fatalf("打开备份失败: %v", err)
	}
	t.Cleanup(func() { _ = snap.Close() })

	var body string
	if err := snap.QueryRow(`SELECT body FROM notes WHERE id = 1`).Scan(&body); err != nil {
		t.Fatalf("从备份里读数据失败: %v", err)
	}
	if body != "备份里的这一行必须还在" {
		t.Fatalf("备份里的内容不对: %q", body)
	}
}

// 备份期间源库还开着（服务不停机）也要能成。
func TestBackupWhileSourceIsOpen(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "live.db")
	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("建表失败: %v", err)
	}

	out := filepath.Join(dir, "snap.db")
	if err := Backup(context.Background(), dbPath, out); err != nil {
		t.Fatalf("运行中备份失败: %v", err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("运行中备份没有产出文件: %v", err)
	}
}

func TestBackupRefusesExistingTarget(t *testing.T) {
	dbPath := openTemp(t)
	out := filepath.Join(t.TempDir(), "exists.db")
	if err := os.WriteFile(out, []byte("旧备份"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}

	err := Backup(context.Background(), dbPath, out)
	if err == nil {
		t.Fatal("目标文件已存在时应当报错，否则会悄悄覆盖旧备份")
	}
	if !strings.Contains(err.Error(), "已存在") {
		t.Fatalf("错误信息应说明文件已存在，实际: %v", err)
	}
	// 旧文件不能被改：覆盖失败也得留下原样。
	content, readErr := os.ReadFile(out)
	if readErr != nil || string(content) != "旧备份" {
		t.Fatalf("旧备份被改动了: %q (%v)", content, readErr)
	}
}

func TestBackupRejectsEmptyPaths(t *testing.T) {
	if err := Backup(context.Background(), "", filepath.Join(t.TempDir(), "a.db")); err == nil {
		t.Fatal("源库路径为空时应报错")
	}
	if err := Backup(context.Background(), openTemp(t), ""); err == nil {
		t.Fatal("目标路径为空时应报错")
	}
}

// 备份出来的库不该依赖源库的 -wal / -shm：删掉源库只留备份，备份必须还能读。
func TestBackupIsSelfContained(t *testing.T) {
	dbPath := openTemp(t)
	out := filepath.Join(t.TempDir(), "snap.db")
	if err := Backup(context.Background(), dbPath, out); err != nil {
		t.Fatalf("备份失败: %v", err)
	}

	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(dbPath + suffix); err != nil && !os.IsNotExist(err) {
			t.Fatalf("删除源库 %s 失败: %v", suffix, err)
		}
	}
	if err := os.Remove(dbPath); err != nil {
		t.Fatalf("删除源库失败: %v", err)
	}

	snap, err := Open(out)
	if err != nil {
		t.Fatalf("打开备份失败: %v", err)
	}
	t.Cleanup(func() { _ = snap.Close() })
	var count int
	if err := snap.QueryRow(`SELECT COUNT(*) FROM notes`).Scan(&count); err != nil {
		t.Fatalf("读备份失败: %v", err)
	}
	if count != 1 {
		t.Fatalf("备份里的行数不对: %d", count)
	}
}

// 目标目录不存在时要自己建出来（脚本传 ./backups/xxx.db 是常见写法）。
func TestBackupCreatesTargetDirectory(t *testing.T) {
	dbPath := openTemp(t)
	out := filepath.Join(t.TempDir(), "nested", "deeper", "snap.db")

	if err := Backup(context.Background(), dbPath, out); err != nil {
		t.Fatalf("备份失败: %v", err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("备份文件不存在: %v", err)
	}
}
