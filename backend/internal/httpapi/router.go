// Package httpapi 组装路由与中间件链。
//
// 本包只负责「把请求送到 handler」与「统一出口格式」，不含业务规则。
// 依赖方向：httpapi → handler → service → repository / convert / storage。
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/handler"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// ReadyCheck 是就绪探针的一项依赖检查。
type ReadyCheck struct {
	// Name 是检查项名称，会出现在响应与日志里（如 "database"）。
	Name string
	// Ping 返回 nil 表示该项健康。
	Ping func(ctx context.Context) error
}

// Deps 是路由层需要的依赖。
//
// 后续里程碑会往这里加 service（Map / Share / Admin…）。
type Deps struct {
	Config *config.Config
	Logger *slog.Logger
	Ready  []ReadyCheck
	// Auth 处理认证接口；Sessions 提供 RequireAuth 需要的令牌校验。
	Auth     *handler.AuthHandler
	Sessions *service.AuthService
}

// NewRouter 构建 HTTP 处理器。
func NewRouter(deps Deps) http.Handler {
	if deps.Config.IsProduction() {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.RedirectTrailingSlash = false
	r.HandleMethodNotAllowed = true

	// 顺序与 docs/04-后端设计与API规范.md §3 一致。
	// RateLimit / RequireAuth / RequireRole 在 M1 接入。
	r.Use(
		middleware.Recover(deps.Logger),
		middleware.RequestID(),
		middleware.Logger(deps.Logger),
		middleware.CORS(deps.Config.CORSOrigins),
	)

	// 只有来自受信网段的 X-Forwarded-For 才可信。不配置就完全不信任，
	// ClientIP 退回 RemoteAddr——否则限流与审计记录到的是伪造 IP。
	if len(deps.Config.TrustedProxies) > 0 {
		_ = r.SetTrustedProxies(deps.Config.TrustedProxies)
	} else {
		_ = r.SetTrustedProxies(nil)
	}

	r.NoRoute(notFound)
	r.NoMethod(notFound)

	v1 := r.Group("/api/v1")
	registerHealth(v1, deps)
	registerAuth(v1, deps, authLimiters{
		// 策略见 docs/04 §3.1。登录的限流维度含账号，放在 handler 里，
		// 这里只处理「只按 IP」的两个入口。
		register: middleware.NewRateLimiter(3, time.Hour, 3),
		refresh:  middleware.NewRateLimiter(30, time.Minute, 30),
	})

	return r
}

// authLimiters 是认证入口的限流器。
type authLimiters struct {
	register *middleware.RateLimiter
	refresh  *middleware.RateLimiter
}

// registerAuth 注册认证接口。
//
// /auth/me 需要登录态，其余四个接口本身是「获取登录态」的入口，不能挂
// RequireAuth——那会形成「没令牌就刷新不了、刷新不了就永远没令牌」的死锁。
func registerAuth(v1 *gin.RouterGroup, deps Deps, limiters authLimiters) {
	if deps.Auth == nil {
		return
	}
	g := v1.Group("/auth")
	g.POST("/register", limiters.register.Middleware(middleware.ClientIPKey), deps.Auth.Register)
	g.POST("/login", deps.Auth.Login)
	g.POST("/refresh", limiters.refresh.Middleware(middleware.ClientIPKey), deps.Auth.Refresh)
	g.POST("/logout", deps.Auth.Logout)

	if deps.Sessions != nil {
		g.GET("/me", middleware.RequireAuth(deps.Sessions), deps.Auth.Me)
	}
}

// notFound 统一 404/405 的响应体。
//
// gin 默认返回纯文本 "404 page not found"，与其它接口的信封格式不一致，
// 会让前端的错误处理多一条特殊分支。
func notFound(c *gin.Context) {
	response.Fail(c, apperr.New(apperr.CodeResourceNotFound, ""))
}
