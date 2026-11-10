// Package mcpserver 在桌面端跑一个**本地** MCP 服务，让 AI 客户端直接读写本机导图。
//
// 与「登录云端」无关：数据在本机，AI 操作的就是本机这一份。端口与令牌来自
// 本地站点设置（mcp.port / mcp.token），改完立即生效——不需要重启应用。
package mcpserver

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/woliubang256/wmind/backend/internal/mcp"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// Manager 负责本地 MCP 服务的生命周期。
type Manager struct {
	maps    *service.MapService
	ownerID int64
	version string
	logger  *slog.Logger

	mu     sync.Mutex
	server *http.Server
	port   int
}

// New 构造管理器。
func New(maps *service.MapService, ownerID int64, version string, logger *slog.Logger) *Manager {
	return &Manager{maps: maps, ownerID: ownerID, version: version, logger: logger}
}

// Apply 按最新配置启动、重启或停止本地 MCP 服务。
//
// enabled=false 时停掉；端口变化时先停再起；端口相同且已在跑则只更新令牌
// （令牌是每请求读的，但服务实例持有它，所以同样要重启）。
func (m *Manager) Apply(ctx context.Context, enabled bool, port int, token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
	if !enabled || token == "" {
		return nil
	}
	if port <= 0 || port > 65535 {
		return fmt.Errorf("端口不合法：%d", port)
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return fmt.Errorf("本地 MCP 端口 %d 被占用：%w", port, err)
	}
	handler := mcp.New(mcp.Deps{
		Maps:    m.maps,
		Token:   token,
		Version: m.version,
		Logger:  m.logger,
		Owner: func(context.Context) (int64, error) {
			// 本地模式只有一个用户：AI 操作的就是这台机器的数据。
			return m.ownerID, nil
		},
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 15 * time.Second}
	m.server = server
	m.port = port
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			m.logger.Warn("local mcp server stopped", "err", err)
		}
	}()
	// 不能在这里调 m.URL()：它要拿同一把锁，会自锁。
	m.logger.Info("local mcp server listening", "port", port)
	return nil
}

// URL 返回本地 MCP 地址；未运行时为空。
func (m *Manager) URL() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.server == nil {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d/mcp", m.port)
}

// Stop 停止服务。
func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
}

func (m *Manager) stopLocked() {
	if m.server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = m.server.Shutdown(ctx)
	m.server = nil
	m.port = 0
}
