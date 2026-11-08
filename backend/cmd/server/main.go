// Command server is wmind's backend entry point.
//
// Responsibilities: load configuration, serve HTTP, and shut down gracefully.
// Dependency assembly lives in internal/bootstrap, which the desktop client
// shares; business logic lives in the modular application layers.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/woliubang256/wmind/backend/internal/bootstrap"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/pkg/logger"
)

// shutdownTimeout is bounded by the container stop_grace_period with 5s spare.
const shutdownTimeout = 15 * time.Second

// errAlreadyReported 表示错误已经自己打印过了（子命令的用法提示等），
// main 只需要退出码，不必再套一层 "startup failed" 前缀——那会让
// `wmind db` 的用法提示看起来像服务启动失败。
var errAlreadyReported = errors.New("already reported")

func main() {
	if err := run(); err != nil {
		if errors.Is(err, errAlreadyReported) {
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "wmind startup failed: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := logger.New(cfg.LogLevel, cfg.IsProduction())
	slog.SetDefault(log)

	// 一次性子命令（目前只有 `db backup`）在起服务之前处理掉：同一个二进制
	// 既是服务又是运维工具，生产镜像里不需要第二个可执行文件。
	if handled, err := runDBSubcommand(context.Background(), cfg, os.Args[1:], log); handled {
		if err != nil {
			// 子命令的错误自己打印：用法提示套上 "startup failed" 会看不懂。
			fmt.Fprintf(os.Stderr, "wmind: %v\n", err)
			return errAlreadyReported
		}
		return nil
	}

	log.Info("wmind backend starting", cfg.Summary()...)

	app, err := bootstrap.New(context.Background(), cfg, bootstrap.Options{Logger: log})
	if err != nil {
		return err
	}
	// 后台任务与数据库由 App 持有：进程退出前必须 Close，且要在 HTTP
	// 服务器停止之后——否则正在处理的请求可能撞上已关闭的数据库。
	defer app.Close()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           app.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()
	log.Info("HTTP server listening", "addr", cfg.Addr)

	select {
	case err := <-serveErr:
		return fmt.Errorf("HTTP server exited unexpectedly: %w", err)
	case <-ctx.Done():
		log.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown timed out", "err", err)
	}
	log.Info("server stopped")
	return nil
}
