package middleware

import (
	"github.com/gin-gonic/gin"

	idgen "github.com/woliubang256/wmind/backend/internal/pkg/id"
	"github.com/woliubang256/wmind/backend/internal/pkg/reqid"
)

// HeaderRequestID 是请求 ID 的传递头，出入方向同名。
const HeaderRequestID = "X-Request-Id"

// RequestID 生成或透传请求 ID。
//
// 上游（Nginx、网关）若已生成，则透传以便跨服务串联；但**只接受合法 ULID**，
// 否则外部可以往日志里注入任意字符串（换行、超长内容），把日志搞乱。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := c.GetHeader(HeaderRequestID)
		if !idgen.Valid(requestID) {
			requestID = idgen.New()
		}

		c.Set(ctxKeyRequestID, requestID)
		c.Writer.Header().Set(HeaderRequestID, requestID)
		c.Request = c.Request.WithContext(
			reqid.WithContext(c.Request.Context(), requestID),
		)

		c.Next()
	}
}
