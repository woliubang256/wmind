package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// RequireAuth 校验 Access Token，并把用户身份写进请求上下文。
//
// 用户状态由 service 每次确认（带 60 秒缓存，禁用时主动失效）：JWT 里
// 不带 status，否则「禁用账号」要等令牌过期才生效。
func RequireAuth(auth *service.AuthService) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := BearerToken(c.GetHeader("Authorization"))
		if token == "" {
			response.Abort(c, apperr.New(apperr.CodeAuthTokenInvalid, ""))
			return
		}

		user, err := auth.Authenticate(c.Request.Context(), token)
		if err != nil {
			response.Abort(c, err)
			return
		}

		c.Set(ctxKeyUserID, user.UID)
		c.Set(ctxKeyUserDBID, user.ID)
		c.Set(ctxKeyUserRole, string(user.Role))
		c.Next()
	}
}

// RequireRole 限制只有指定角色可以访问。必须挂在 RequireAuth 之后。
func RequireRole(roles ...domain.Role) gin.HandlerFunc {
	allowed := make(map[string]struct{}, len(roles))
	for _, role := range roles {
		allowed[string(role)] = struct{}{}
	}
	return func(c *gin.Context) {
		if _, ok := allowed[UserRole(c)]; !ok {
			response.Abort(c, apperr.New(apperr.CodeAuthForbidden, ""))
			return
		}
		c.Next()
	}
}

// BearerToken 从 Authorization 头里取出 Bearer 令牌；格式不符返回空串。
//
// 前缀比较忽略大小写（RFC 7235 的 scheme 是大小写不敏感的），但令牌本体
// 原样返回——它区分大小写。
func BearerToken(header string) string {
	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
