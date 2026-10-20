// 一次性子命令：`wmind db backup --out <path>`。
//
// 为什么放在服务二进制里而不是单独的 CLI 可执行文件：
//
//   - 生产镜像里只有一个二进制（见 deploy/Dockerfile.backend），备份脚本用
//     `docker compose exec api /app/wmind db backup` 就能跑，不用再塞一个工具；
//   - 备份要用的 SQLite 连接参数（WAL、busy_timeout 等 pragma）与线上完全一致，
//     复制一份到另一个二进制里迟早会漂移。
//
// 方言分支写在这里而不是 internal/cli：`cmd/server` 的装配 switch 是全仓唯一
// 允许判断方言的地方（见 cmd/dialectcheck 的白名单）。
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/config"
	sqliterepo "github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

const dbUsage = `用法：
  wmind db backup [--out <文件路径>]

说明：
  为 SQLite 数据库产出一份一致性快照（VACUUM INTO），服务可以不停机。
  不指定 --out 时写到数据库同目录的 wmind-backup-<时间戳>.db。
  PostgreSQL 部署请用 pg_dump（见 docs/07-部署与运维.md §7.1）。`

// runDBSubcommand 处理 `db ...` 子命令。
//
// 返回 handled=false 表示 argv 不是子命令，调用方继续启动 HTTP 服务。
// handled=true 时调用方应带着 err 退出，不再启动服务。
func runDBSubcommand(ctx context.Context, cfg *config.Config, args []string, log *slog.Logger) (bool, error) {
	if len(args) == 0 || args[0] != "db" {
		return false, nil
	}
	if len(args) < 2 {
		return true, fmt.Errorf("缺少 db 子命令\n%s", dbUsage)
	}

	switch args[1] {
	case "backup":
		return true, runDBBackup(ctx, cfg, args[2:], log)
	case "help", "-h", "--help":
		return true, nil
	default:
		return true, fmt.Errorf("未知的 db 子命令 %q\n%s", args[1], dbUsage)
	}
}

func runDBBackup(ctx context.Context, cfg *config.Config, args []string, log *slog.Logger) error {
	flags := flag.NewFlagSet("db backup", flag.ContinueOnError)
	// flag 包默认把用法打到 stderr；这里换成自己的说明，避免出现
	// "Usage of db backup:" 这种半英文半中文的混合输出。
	flags.SetOutput(io.Discard)
	out := flags.String("out", "", "备份文件路径")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("%w\n%s", err, dbUsage)
	}
	if flags.NArg() > 0 {
		return fmt.Errorf("多余的参数：%s\n%s", strings.Join(flags.Args(), " "), dbUsage)
	}

	if !cfg.IsSQLite() {
		return fmt.Errorf(
			"db backup 只支持 SQLite（当前驱动 %q）。PostgreSQL 请用 pg_dump，见 docs/07-部署与运维.md §7.1",
			cfg.DB.Driver,
		)
	}

	target := *out
	if target == "" {
		// 默认落在数据库同目录：容器里是 /data，随 data 卷一起存在，
		// 备份脚本会立刻把它 cp 出去再删掉。
		stamp := time.Now().Format("20060102-150405")
		target = filepath.Join(filepath.Dir(cfg.DB.SQLitePath), "wmind-backup-"+stamp+".db")
	}

	// 备份本身有超时：VACUUM INTO 要读全库，库大到几百 MB 时不该无限等。
	backupCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	if err := sqliterepo.Backup(backupCtx, cfg.DB.SQLitePath, target); err != nil {
		return err
	}
	log.Info("数据库备份完成", "out", target)
	// 同时打到 stdout：脚本里 `$(... db backup ...)` 需要拿到路径。
	fmt.Println(target)
	return nil
}
