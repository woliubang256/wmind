package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// allowedHeaders 是跨域请求允许携带的请求头。
var allowedHeaders = strings.Join([]string{
	"Authorization",
	"Content-Type",
	HeaderRequestID,
	"Idempotency-Key",
	"X-Share-Access",
}, ", ")

// CORS 按允许列表放开跨域。
//
// 生产环境前端由 Nginx 同源代理，正常路径下不产生任何 CORS 头；开发环境
// 需要放开 Vite 的 5173 端口。允许列表为空即整体跳过。
//
// 注意不能回 `Access-Control-Allow-Origin: *`：刷新令牌走 httpOnly Cookie，
// 而带凭据的跨域请求**不允许**通配来源，必须回显具体 Origin。
func CORS(origins []string) gin.HandlerFunc {
	allowed := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		allowed[normalizeOrigin(o)] = struct{}{}
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin == "" || len(allowed) == 0 {
			c.Next()
			return
		}
		if _, ok := allowed[normalizeOrigin(origin)]; !ok {
			// 不在允许列表里：不加任何 CORS 头，让浏览器自己拦下来。
			c.Next()
			return
		}
		// Session handlers need the same explicit allowlist for CSRF checks;
		// a CORS response header alone cannot prevent request side effects.
		c.Set(ctxKeyAllowedSessionOrigin, true)

		header := c.Writer.Header()
		header.Set("Access-Control-Allow-Origin", origin)
		header.Set("Access-Control-Allow-Credentials", "true")
		// 响应随 Origin 变化，必须声明 Vary，否则会被缓存串味。
		header.Add("Vary", "Origin")

		if c.Request.Method == http.MethodOptions {
			header.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			header.Set("Access-Control-Allow-Headers", allowedHeaders)
			header.Set("Access-Control-Max-Age", "600")
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}

// normalizeOrigin 抹掉结尾斜杠，避免 `http://localhost:5173` 与
// `http://localhost:5173/` 被当成两个来源。
func normalizeOrigin(origin string) string {
	return strings.TrimRight(strings.TrimSpace(origin), "/")
}
