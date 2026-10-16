package middleware

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Logger 输出访问日志。
//
// 按状态码分级：5xx 记 error、4xx 记 warn、其余记 info。这样默认日志级别下
// 也能一眼看到出问题的请求，不需要额外过滤。
func Logger(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		c.Next()

		attrs := []any{
			"method", c.Request.Method,
			"path", path,
			"status", c.Writer.Status(),
			"durationMs", time.Since(start).Milliseconds(),
			"ip", c.ClientIP(),
			"requestId", RequestIDFrom(c),
		}
		if query != "" {
			attrs = append(attrs, "query", query)
		}
		if uid := UserID(c); uid != "" {
			attrs = append(attrs, "userId", uid)
		}
		if len(c.Errors) > 0 {
			attrs = append(attrs, "ginErrors", c.Errors.String())
		}

		switch {
		case c.Writer.Status() >= http.StatusInternalServerError:
			log.ErrorContext(c.Request.Context(), "请求完成", attrs...)
		case c.Writer.Status() >= http.StatusBadRequest:
			log.WarnContext(c.Request.Context(), "请求完成", attrs...)
		default:
			log.InfoContext(c.Request.Context(), "请求完成", attrs...)
		}
	}
}
