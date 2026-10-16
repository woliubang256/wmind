// Command server 是 wmind 的后端入口。
//
// 职责只有三件：加载配置、装配依赖、启动并优雅关闭 HTTP 服务。
// 业务逻辑一律不放这里。
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

	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/httpapi"
	"github.com/woliubang256/wmind/backend/internal/pkg/logger"
)

// shutdownTimeout 是优雅退出的上限。容器 stop_grace_period 为 20s，
// 留 5s 余量给进程收尾。
const shutdownTimeout = 15 * time.Second

func main() {
	if err := run(); err != nil {
		// 用 stderr 而不是 slog：日志器可能还没建起来（配置就失败了）。
		fmt.Fprintf(os.Stderr, "wmind 启动失败: %v\n", err)
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
	log.Info("wmind 后端启动中", cfg.Summary()...)

	// ── 依赖装配 ──────────────────────────────────────────
	//
	// 数据库连接、迁移与仓储按 cfg.DB.Driver 分叉，这里是全局唯一需要感知
	// 方言的地方（见 docs/04-后端设计与API规范.md §1.2）。M0-4 接入。

	var ready []httpapi.ReadyCheck

	handler := httpapi.NewRouter(httpapi.Deps{
		Config: cfg,
		Logger: log,
		Ready:  ready,
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()
	log.Info("HTTP 服务已监听", "addr", cfg.Addr)

	select {
	case err := <-serveErr:
		return fmt.Errorf("HTTP 服务异常退出: %w", err)
	case <-ctx.Done():
		log.Info("收到退出信号，开始优雅关闭")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("优雅关闭超时，仍有在途请求", "err", err)
	}

	log.Info("已退出")
	return nil
}
