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
	"github.com/woliubang256/wmind/backend/internal/domain"
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
	// RegistrationOpen 报告站点是否开放注册。为 nil 时视为开放。
	//
	// 单独给一个函数而不是塞进 AuthHandler：这道闸门要在**限流器之前**执行，
	// 而限流器是路由层挂的中间件，拿不到 handler 内部的服务实例。
	RegistrationOpen func() bool
	// Users 处理「我的」相关接口（资料、密码、头像）。
	Users *handler.UserHandler
	// Site 处理公开的站点配置；AdminSettings 处理管理员的设置读写。
	Site          *handler.SiteHandler
	AdminSettings *handler.AdminSettingsHandler
	Backups       *handler.BackupHandler
	AI            *handler.AIHandler
	Maintenance   middleware.MaintenanceGate
	// Admin 处理管理后台的用户、统计与审计接口。
	Admin *handler.AdminHandler
	// Maps 处理导图的增删改查与回收站。
	Maps *handler.MapHandler
	// Themes 处理用户自定义主题的增删改查。
	Themes *handler.ThemeHandler
	// Templates 处理用户模板（从导图另存为、列表、改名、删除）。
	// 内置的 8 个模板在前端包里，不经过这里。
	Templates *handler.TemplateHandler
	// Files 处理通用图片上传（导入时的图片还原）。
	Files *handler.FileHandler
	// Shares 处理分享链接的增删改查与两个公开访问接口。
	Shares *handler.ShareHandler
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
		middleware.Maintenance(deps.Maintenance),
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
	registerSite(v1, deps)
	registerAuth(v1, deps, authLimiters{
		// 策略见 docs/04 §3.1。登录的限流维度含账号，放在 handler 里，
		// 这里只处理「只按 IP」的两个入口。
		register: middleware.NewRateLimiter(3, time.Hour, 3),
		refresh:  middleware.NewRateLimiter(30, time.Minute, 30),
	})
	registerUsers(v1, deps)
	registerMaps(v1, deps)
	registerShares(v1, deps)
	registerThemes(v1, deps)
	registerTemplates(v1, deps)
	registerFiles(v1, deps)
	registerAdmin(v1, deps)
	if deps.AI != nil && deps.Sessions != nil {
		v1.POST("/ai/generate", middleware.RequireAuth(deps.Sessions),
			middleware.NewRateLimiter(5, time.Minute, 5).Middleware(middleware.UserKey), deps.AI.Generate)
	}

	// 头像等上传文件由 API 直接提供。生产部署里 Nginx 把 /uploads/ 也代理到
	// 本进程（见 deploy/nginx.conf），所以这里不需要额外的鉴权：头像本来就是
	// 公开资源，URL 里带随机 uid，猜不到别人的。
	if dir := deps.Config.Storage.Dir; dir != "" {
		r.Static("/uploads", dir)
	}

	return r
}

// registerUsers 注册「我的」相关接口，全部要求登录态。
func registerUsers(v1 *gin.RouterGroup, deps Deps) {
	if deps.Users == nil || deps.Sessions == nil {
		return
	}
	g := v1.Group("/users", middleware.RequireAuth(deps.Sessions))
	g.PATCH("/me", deps.Users.UpdateMe)
	g.POST("/me/password", deps.Users.ChangePassword)
	g.POST("/me/avatar", deps.Users.UploadAvatar)
}

// registerSite 注册公开的站点配置接口。
//
// 未登录可访问：登录页要在拿到令牌之前就知道「注册是否开放、密码几位」。
func registerSite(v1 *gin.RouterGroup, deps Deps) {
	if deps.Site == nil {
		return
	}
	v1.GET("/site/config", deps.Site.Config)
}

// registerMaps 注册导图与回收站接口，全部要求登录态。
//
// 导图的属主隔离在仓储层用 owner_id 谓词强制（见 domain.MapRepo 的注释），
// 所以这里不需要额外的权限中间件——**没有「管理员可以看别人导图」的入口**，
// 那是刻意留白的：一期没有这个需求，多一个入口就多一处越权风险。
func registerMaps(v1 *gin.RouterGroup, deps Deps) {
	if deps.Maps == nil || deps.Sessions == nil {
		return
	}
	auth := middleware.RequireAuth(deps.Sessions)

	g := v1.Group("/maps", auth)
	g.GET("", deps.Maps.List)
	g.POST("", deps.Maps.Create)
	g.GET("/:uid", deps.Maps.Get)
	g.PUT("/:uid", deps.Maps.Save)
	g.PATCH("/:uid", deps.Maps.Rename)
	g.PUT("/:uid/thumbnail", deps.Maps.UpdateThumbnail)
	g.DELETE("/:uid", deps.Maps.Delete)
	g.POST("/:uid/duplicate", deps.Maps.Duplicate)

	trash := v1.Group("/trash", auth)
	trash.GET("", deps.Maps.ListTrash)
	trash.DELETE("", deps.Maps.EmptyTrash)
	trash.POST("/:uid/restore", deps.Maps.Restore)
	trash.DELETE("/:uid", deps.Maps.Purge)
}

// registerShares 注册分享链接接口。
//
// 分成三组，鉴权边界各不相同：
//
//   - `/maps/{uid}/shares`：属主为某张导图建链、看链，要求登录。
//   - `/shares`：管理自己建的链接（列表 / 改设置 / 撤销），要求登录。
//   - `/public/shares`：匿名访问，**不能**挂 RequireAuth——分享页的访客
//     通常没有账号。它的安全边界完全由令牌（128 bit 随机）与密码承担。
//
// 校验密码的入口按 IP 限流 10 次/分钟（docs/04 §5.7）：分享密码往往是
// 四位数字，不限流的话 10000 种组合几分钟就能穷举完。
func registerShares(v1 *gin.RouterGroup, deps Deps) {
	if deps.Shares == nil {
		return
	}

	if deps.Sessions != nil {
		auth := middleware.RequireAuth(deps.Sessions)
		maps := v1.Group("/maps", auth)
		maps.POST("/:uid/shares", deps.Shares.Create)
		maps.GET("/:uid/shares", deps.Shares.ListByMap)

		shares := v1.Group("/shares", auth)
		shares.GET("", deps.Shares.ListMine)
		shares.PATCH("/:uid", deps.Shares.Update)
		shares.DELETE("/:uid", deps.Shares.Revoke)
	}

	public := v1.Group("/public/shares")
	public.GET("/:token", deps.Shares.PublicGet)
	public.POST("/:token/verify",
		middleware.NewRateLimiter(10, time.Minute, 10).Middleware(middleware.ClientIPKey),
		deps.Shares.PublicVerify)
}

// registerThemes 注册自定义主题接口，全部要求登录态。
//
// 内置的 10 套配色**不在这里**：它们是前端包内的静态资源，编辑器首帧就要
// 解析样式，不能等一个请求回来。这张表只放用户自建的主题（docs/04 §5.5）。
func registerThemes(v1 *gin.RouterGroup, deps Deps) {
	if deps.Themes == nil || deps.Sessions == nil {
		return
	}
	g := v1.Group("/themes", middleware.RequireAuth(deps.Sessions))
	g.GET("", deps.Themes.List)
	g.POST("", deps.Themes.Create)
	g.PUT("/:uid", deps.Themes.Update)
	g.DELETE("/:uid", deps.Themes.Delete)
}

// registerTemplates 注册用户模板接口，全部要求登录态。
//
// 内置的 8 个模板不在这里：它们编译进前端包，选择对话框直接本地渲染。
// 这里只管「用户把自己的导图另存为模板」这一半。
func registerTemplates(v1 *gin.RouterGroup, deps Deps) {
	if deps.Templates == nil || deps.Sessions == nil {
		return
	}
	g := v1.Group("/templates", middleware.RequireAuth(deps.Sessions))
	g.GET("", deps.Templates.List)
	g.GET("/:uid", deps.Templates.Get)
	g.POST("", deps.Templates.Create)
	g.PATCH("/:uid", deps.Templates.Rename)
	g.DELETE("/:uid", deps.Templates.Delete)
}

// registerFiles 注册通用图片上传，要求登录态。
//
// 限流按**用户**（20 次/分钟，docs/04 §3.1）而不是 IP：上传是「一个人连着
// 传几十张图」的形态，按 IP 会让同一出口的人互相挤占配额。
//
// 只有 POST：文件由 `/uploads` 静态目录直接回放，与头像同一条映射。缺
// `files` 表意味着没有属主信息，所以**没有** DELETE——那要等 M5 补表。
func registerFiles(v1 *gin.RouterGroup, deps Deps) {
	if deps.Files == nil || deps.Sessions == nil {
		return
	}
	// 120 次/分钟/用户，与前端 `IMPORT_LIMITS.maxAssets`（100 张）是一对：
	// 一次导入会把图片**串行**传完，额度必须装得下一次完整的导入，否则用户
	// 在第 21 张之后就只能看着「图片未能还原」。改一个必须同时改另一个。
	//
	// 按用户而不是按 IP：同一个办公室出口 IP 可能有多个人同时导入，按 IP
	// 限流会让同事互相拖累；而上传的滥用面是「往磁盘里灌东西」，按账号记
	// 才是对的。
	limit := middleware.NewRateLimiter(120, time.Minute, 120)
	g := v1.Group("/files", middleware.RequireAuth(deps.Sessions))
	g.POST("", limit.Middleware(middleware.UserKey), deps.Files.Upload)
}

// registerAdmin 注册管理后台接口。
//
// 整组挂在 RequireAuth + RequireRole(admin) 之后：管理接口漏一个鉴权就是
// 全站权限失守，逐个接口加容易漏，按组加只需要检查一处。
func registerAdmin(v1 *gin.RouterGroup, deps Deps) {
	if deps.Sessions == nil {
		return
	}
	g := v1.Group("/admin",
		middleware.RequireAuth(deps.Sessions),
		middleware.RequireRole(domain.RoleAdmin),
	)
	if deps.AI != nil {
		g.GET("/ai", deps.AI.Get)
		g.PUT("/ai", deps.AI.Save)
	}
	if deps.Backups != nil {
		g.GET("/backups", deps.Backups.Get)
		g.PUT("/backups/config", deps.Backups.Save)
		g.POST("/backups/test", deps.Backups.Test)
		g.POST("/backups/run", deps.Backups.Run)
		g.POST("/backups/schedule", deps.Backups.Schedule)
		g.POST("/backups/restore/preview", deps.Backups.Preview)
		g.POST("/backups/restore", deps.Backups.Restore)
	}
	if deps.AdminSettings != nil {
		g.GET("/settings", deps.AdminSettings.Get)
		g.PUT("/settings", deps.AdminSettings.Update)
	}
	if deps.Admin != nil {
		g.GET("/users", deps.Admin.ListUsers)
		g.POST("/users", deps.Admin.CreateUser)
		g.PATCH("/users/:uid", deps.Admin.UpdateUser)
		g.DELETE("/users/:uid", deps.Admin.DeleteUser)
		g.POST("/users/:uid/reset-password", deps.Admin.ResetPassword)
		g.GET("/stats", deps.Admin.Stats)
		g.GET("/audit-logs", deps.Admin.ListAuditLogs)
	}
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
	// 顺序是刻意的：先判「注册是否开放」，再进限流器。
	//
	// 反过来写的话，关站期间的每次探测都会消耗 3 次/小时的注册配额——用户点
	// 三下就把自己的 IP 锁死一小时，而且拿到的错误是 RATE_LIMITED，看不出
	// 真正的原因是站点关了注册。见 middleware.RequireRegistrationOpen。
	g.POST("/register",
		middleware.RequireRegistrationOpen(deps.RegistrationOpen),
		limiters.register.Middleware(middleware.ClientIPKey),
		deps.Auth.Register)
	g.POST("/login", deps.Auth.Login)
	g.POST("/login/challenge", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Next()
	}, middleware.NewRateLimiter(60, time.Minute, 60).Middleware(middleware.ClientIPKey), deps.Auth.LoginChallenge)
	g.POST("/2fa/verify", middleware.NewRateLimiter(10, time.Minute, 10).Middleware(middleware.ClientIPKey), deps.Auth.VerifyTwoFactor)
	g.POST("/refresh", limiters.refresh.Middleware(middleware.ClientIPKey), deps.Auth.Refresh)
	g.POST("/logout", deps.Auth.Logout)

	if deps.Sessions != nil {
		g.GET("/me", middleware.RequireAuth(deps.Sessions), deps.Auth.Me)
		factor := g.Group("/2fa", middleware.RequireAuth(deps.Sessions), middleware.NewRateLimiter(20, time.Minute, 20).Middleware(middleware.ClientIPKey))
		factor.GET("/status", deps.Auth.TwoFactorStatus)
		factor.POST("/setup", deps.Auth.SetupTwoFactor)
		factor.POST("/enable", deps.Auth.EnableTwoFactor)
		factor.POST("/disable", deps.Auth.DisableTwoFactor)
		factor.POST("/recovery-codes", deps.Auth.RegenerateRecoveryCodes)
	}
}

// notFound 统一 404/405 的响应体。
//
// gin 默认返回纯文本 "404 page not found"，与其它接口的信封格式不一致，
// 会让前端的错误处理多一条特殊分支。
func notFound(c *gin.Context) {
	response.Fail(c, apperr.New(apperr.CodeResourceNotFound, ""))
}
