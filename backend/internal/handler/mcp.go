package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/mcp"
	"github.com/woliubang256/wmind/backend/internal/service"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// MCPHandler 把 /mcp 暴露给 AI 客户端。
//
// 是否开启、用哪个令牌、以谁的身份操作，全部来自站点设置——所以这个 handler
// 每次请求都读一次快照，管理员改完设置立即生效，不用重启服务。
type MCPHandler struct {
	settings *settings.Service
	maps     *service.MapService
	users    domain.UserRepo
	version  string
	logger   Logger
}

// Logger 是最小日志接口，避免 handler 包依赖具体日志实现。
type Logger interface {
	Warn(msg string, args ...any)
}

// NewMCPHandler 构造 MCP 端点。
func NewMCPHandler(svc *settings.Service, maps *service.MapService, users domain.UserRepo, version string, logger Logger) *MCPHandler {
	return &MCPHandler{settings: svc, maps: maps, users: users, version: version, logger: logger}
}

// Handle 处理 POST /mcp。
func (h *MCPHandler) Handle(c *gin.Context) {
	snapshot := h.settings.Snapshot()
	token := snapshot.String("mcp.token")
	ownerUID := snapshot.String("mcp.owner_uid")
	if !snapshot.Bool("mcp.enabled") || token == "" || ownerUID == "" {
		// 未开启时和「路径不存在」一个待遇：不暴露这里有没有 MCP。
		c.Status(http.StatusNotFound)
		return
	}

	handler := mcp.New(mcp.Deps{
		Maps:    h.maps,
		Token:   token,
		Version: h.version,
		Owner: func(ctx context.Context) (int64, error) {
			// 令牌是站点级的：操作身份固定为「开启它的那个管理员」。
			user, err := h.users.GetByUID(ctx, ownerUID)
			if err != nil {
				return 0, err
			}
			if !user.IsActive() {
				return 0, errors.New("开启 MCP 的账号已被停用")
			}
			return user.ID, nil
		},
	})
	handler.ServeHTTP(c.Writer, c.Request)
}
