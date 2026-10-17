// Package handler 把 HTTP 请求翻译成 service 调用，再把结果写回统一信封。
//
// 本包不含业务规则：参数校验的「格式」部分在这里，策略部分在 service。
// 这样同一个 service 方法可以被 HTTP、CLI 或测试直接调用。
package handler

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// CookieConfig 描述刷新令牌 Cookie 的属性。
//
// Path 固定为 /api/v1/auth：刷新与登出都在这个前缀下，浏览器不会把它带到
// 其它请求上，减少 XSS 之外的泄露面。Secure 在生产必须为 true。
type CookieConfig struct {
	Name     string
	Path     string
	Domain   string
	Secure   bool
	SameSite http.SameSite
	MaxAge   time.Duration
}

// DefaultCookieConfig 返回 Web 端的默认 Cookie 配置。
func DefaultCookieConfig(secure bool, maxAge time.Duration) CookieConfig {
	return CookieConfig{
		Name: "wmind_refresh", Path: "/api/v1/auth", Secure: secure,
		SameSite: http.SameSiteLaxMode, MaxAge: maxAge,
	}
}

// AuthHandler 处理认证相关接口。
type AuthHandler struct {
	svc    *service.AuthService
	cookie CookieConfig
}

// NewAuthHandler 构造认证 handler。
func NewAuthHandler(svc *service.AuthService, cookie CookieConfig) *AuthHandler {
	if cookie.Name == "" {
		cookie = DefaultCookieConfig(false, 7*24*time.Hour)
	}
	return &AuthHandler{svc: svc, cookie: cookie}
}

type registerRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
}

// Register 处理 POST /api/v1/auth/register。
func (h *AuthHandler) Register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	result, err := h.svc.Register(c.Request.Context(), service.RegisterInput{
		Username: req.Username, Email: req.Email, Password: req.Password, Nickname: req.Nickname,
		Meta: h.sessionMeta(c),
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, result)
	response.Created(c, toAuthResponse(result))
}

type loginRequest struct {
	Identifier string `json:"identifier"`
	Password   string `json:"password"`
}

// Login 处理 POST /api/v1/auth/login。
func (h *AuthHandler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	result, err := h.svc.Login(c.Request.Context(), service.LoginInput{
		Identifier: req.Identifier, Password: req.Password, Meta: h.sessionMeta(c),
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, result)
	response.OK(c, toAuthResponse(result))
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

// Refresh 处理 POST /api/v1/auth/refresh。
//
// Web 走 HttpOnly Cookie，客户端（App）走请求体；两者共用同一接口，
// Cookie 优先——浏览器里 Cookie 是更安全的那条路径。
func (h *AuthHandler) Refresh(c *gin.Context) {
	result, err := h.svc.Refresh(c.Request.Context(), h.refreshToken(c), h.sessionMeta(c))
	if err != nil {
		// 刷新失败意味着会话已死，顺手清掉旧 Cookie，避免前端反复重试。
		h.clearRefreshCookie(c)
		response.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, result)
	response.OK(c, toAuthResponse(result))
}

// Logout 处理 POST /api/v1/auth/logout。幂等，始终 204。
func (h *AuthHandler) Logout(c *gin.Context) {
	if err := h.svc.Logout(c.Request.Context(), h.refreshToken(c)); err != nil {
		response.Fail(c, err)
		return
	}
	h.clearRefreshCookie(c)
	response.NoContent(c)
}

// Me 处理 GET /api/v1/auth/me。
func (h *AuthHandler) Me(c *gin.Context) {
	user, err := h.svc.Me(c.Request.Context(), middleware.UserID(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toUserDTO(user))
}

func (h *AuthHandler) sessionMeta(c *gin.Context) service.SessionMeta {
	return service.SessionMeta{Platform: "web", Device: c.Request.UserAgent()}
}

func (h *AuthHandler) refreshToken(c *gin.Context) string {
	if value, err := c.Cookie(h.cookie.Name); err == nil && value != "" {
		return value
	}
	// 没有 Cookie 时才读请求体：Cookie 存在说明是浏览器，body 里的值
	// 可能是攻击者塞进来的（CSRF 场景下不该被优先采用）。
	if c.Request.ContentLength == 0 {
		return ""
	}
	var body refreshRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		return ""
	}
	return body.RefreshToken
}

func (h *AuthHandler) setRefreshCookie(c *gin.Context, result *service.AuthResult) {
	maxAge := int(h.cookie.MaxAge.Seconds())
	if !result.RefreshExpiresAt.IsZero() {
		maxAge = int(time.Until(result.RefreshExpiresAt).Seconds())
		if maxAge < 0 {
			maxAge = 0
		}
	}
	c.SetSameSite(h.cookie.SameSite)
	c.SetCookie(h.cookie.Name, result.RefreshToken, maxAge, h.cookie.Path, h.cookie.Domain, h.cookie.Secure, true)
}

func (h *AuthHandler) clearRefreshCookie(c *gin.Context) {
	c.SetSameSite(h.cookie.SameSite)
	c.SetCookie(h.cookie.Name, "", -1, h.cookie.Path, h.cookie.Domain, h.cookie.Secure, true)
}

// userDTO 是用户信息的线上结构。
//
// 时间统一格式化成秒级 RFC 3339 UTC：直接序列化 time.Time 会带上纳秒
// 和时区偏移，前端解析与快照测试都会因此不稳定。
type userDTO struct {
	UID              string  `json:"uid"`
	Username         string  `json:"username"`
	Email            string  `json:"email"`
	Nickname         string  `json:"nickname"`
	AvatarURL        string  `json:"avatarUrl"`
	Role             string  `json:"role"`
	Status           string  `json:"status"`
	MapCount         int     `json:"mapCount"`
	StorageUsedBytes int64   `json:"storageUsedBytes"`
	LastLoginAt      *string `json:"lastLoginAt"`
	CreatedAt        string  `json:"createdAt"`
}

type authResponse struct {
	AccessToken string  `json:"accessToken"`
	ExpiresIn   int     `json:"expiresIn"`
	User        userDTO `json:"user"`
}

func toAuthResponse(result *service.AuthResult) authResponse {
	return authResponse{
		AccessToken: result.AccessToken,
		ExpiresIn:   result.ExpiresIn,
		User:        toUserDTO(result.User),
	}
}

func toUserDTO(user *domain.User) userDTO {
	dto := userDTO{
		UID: user.UID, Username: user.Username, Email: user.Email,
		Nickname: user.Nickname, AvatarURL: user.AvatarURL,
		Role: string(user.Role), Status: string(user.Status),
		MapCount: user.MapCount, CreatedAt: formatTime(user.CreatedAt),
	}
	if user.LastLoginAt != nil {
		value := formatTime(*user.LastLoginAt)
		dto.LastLoginAt = &value
	}
	return dto
}

func formatTime(t time.Time) string {
	return t.UTC().Truncate(time.Second).Format(time.RFC3339)
}
