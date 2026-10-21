package middleware

import (
	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// RequireRegistrationOpen 在站点关闭注册时直接拒绝请求。
//
// 它必须排在限流器**之前**，理由有两条：
//
//  1. 关站之后每个注册请求都注定失败，再让它消耗令牌桶，等于「关站期间随便
//     点几下就把这个 IP 一小时的注册配额烧光」。管理员重新开站时，刚才点过
//     的人仍然被 429 挡在门外，而原因看起来是「请求太频繁」，与关站无关。
//  2. 客户端拿到的错误必须是 REGISTRATION_CLOSED。429 RATE_LIMITED 会让人
//     以为「等一会儿就能注册」，实际上等一小时也不行。
//
// `open` 为 nil 时视为开放：装配期漏传不该把注册功能悄悄关掉。
func RequireRegistrationOpen(open func() bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if open == nil || open() {
			c.Next()
			return
		}
		response.Abort(c, apperr.New(apperr.CodeRegistrationClosed, ""))
	}
}
