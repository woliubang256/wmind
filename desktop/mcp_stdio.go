package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/woliubang256/wmind/backend/desktop/internal/localmode"
	"github.com/woliubang256/wmind/backend/desktop/internal/logging"
	"github.com/woliubang256/wmind/backend/internal/bootstrap"
	"github.com/woliubang256/wmind/backend/internal/mcp"
)

// runMCPStdio 是 `Wmind mcp-stdio` 子命令：以 **stdio** 传输跑 MCP 服务。
//
// 这是给 MCP 客户端（Claude Desktop 等）用的：客户端把本进程当子进程拉起，
// 通过 stdin/stdout 收发 JSON-RPC。相比 HTTP，stdio 不需要端口、不需要密钥、
// 也不会在本机留下一个监听中的端口——客户端能启动它就说明是同一个人在用。
//
// 数据直接读本机的 SQLite（与主程序同一份），所以主程序没开着也能用；
// 反过来，用户没在设置里开启 MCP 时这里直接拒绝启动。
func runMCPStdio() int {
	userData, err := os.UserConfigDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "wmind mcp-stdio: 找不到配置目录: %v\n", err)
		return 1
	}
	root := filepath.Join(userData, "Wmind")
	if override := strings.TrimSpace(os.Getenv("WMIND_DESKTOP_DATA_DIR")); override != "" {
		root = override
	}
	paths, err := localmode.ResolvePaths(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wmind mcp-stdio: %v\n", err)
		return 1
	}
	// 日志只写文件与 stderr：stdout 是 JSON-RPC 通道，混进一行日志客户端就解析失败。
	logger, closeLog, logErr := logging.New(logging.Options{Root: paths.Root, Stderr: true})
	defer closeLog()
	if logErr != nil {
		fmt.Fprintf(os.Stderr, "wmind mcp-stdio: 日志不可用: %v\n", logErr)
	}
	secrets, err := localmode.LoadSecrets(paths.Secrets)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wmind mcp-stdio: 读取本地密钥失败: %v\n", err)
		return 1
	}

	ctx := context.Background()
	// SkipWorkers：这个进程只读设置与导图，不该再起一套备份/清理任务。
	app, err := bootstrap.New(ctx, localmode.Config(paths, secrets), bootstrap.Options{
		Logger: logger, Quiet: true, SkipWorkers: true,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "wmind mcp-stdio: 打开本地数据失败: %v\n", err)
		return 1
	}
	defer app.Close()

	snapshot := app.Settings.Snapshot()
	if !snapshot.Bool("mcp.enabled") {
		fmt.Fprintln(os.Stderr, "wmind mcp-stdio: MCP 未开启。请在 Wmind 的「MCP 服务」里启用后重试。")
		return 1
	}
	user, err := app.Users.GetByEmail(ctx, localmode.LocalEmail)
	if err != nil {
		fmt.Fprintf(os.Stderr, "wmind mcp-stdio: 找不到本地用户: %v\n", err)
		return 1
	}

	logger.Info("mcp stdio started", "data", paths.Root)
	if err := mcp.ServeStdio(ctx, mcp.Deps{
		Maps:    app.MapService,
		Version: appVersion(),
		Logger:  logger,
		Owner:   func(context.Context) (int64, error) { return user.ID, nil },
	}, os.Stdin, os.Stdout, logger); err != nil {
		fmt.Fprintf(os.Stderr, "wmind mcp-stdio: %v\n", err)
		return 1
	}
	return 0
}
