package sqlite

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// Backup 用 `VACUUM INTO` 产出一份一致性快照，写到 outPath。
//
// 为什么是 `VACUUM INTO` 而不是拷文件：数据库跑在 WAL 模式下，`.db` 文件本身
// 可能不含最近的提交（数据还在 `-wal` 里），直接 `cp` 会拷出一份**丢了最近
// 写入**的备份；而且运行中直接拷还可能撞上正在写的页，得到损坏文件。
// `VACUUM INTO` 是单事务读快照，顺带合并 WAL、整理碎片，产物是一个自洽的单文件。
//
// 服务正在跑的时候也能安全调用：它是读操作，不会阻塞写入（WAL 下读写互不
// 阻塞）。这正是备份脚本在不停机的前提下工作的前提（docs/07 §7.1）。
func Backup(ctx context.Context, dbPath, outPath string) error {
	if dbPath == "" {
		return fmt.Errorf("未配置 SQLite 路径（WMIND_SQLITE_PATH）")
	}
	if outPath == "" {
		return fmt.Errorf("未指定备份输出路径")
	}
	// VACUUM INTO 自己也会拒绝已存在的目标文件，但报错是
	// "output file already exists"，看不出是哪个文件。这里先拦一道，把路径说清楚。
	if _, err := os.Stat(outPath); err == nil {
		return fmt.Errorf("备份文件已存在：%s（不覆盖已有备份）", outPath)
	}
	if dir := filepath.Dir(outPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return fmt.Errorf("创建备份目录 %s 失败: %w", dir, err)
		}
	}

	db, err := Open(dbPath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	// 路径用参数绑定而不是拼字符串：备份路径可能带空格或引号。
	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", outPath); err != nil {
		return fmt.Errorf("执行 VACUUM INTO 失败: %w", err)
	}

	// 空文件或只有 4KB 的产物说明快照没写成（磁盘满、权限问题都可能出现）。
	info, err := os.Stat(outPath)
	if err != nil {
		return fmt.Errorf("备份文件没有生成: %w", err)
	}
	if info.Size() == 0 {
		return fmt.Errorf("备份文件为空：%s", outPath)
	}
	return nil
}
