package middleware

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

const (
	ordinaryBodyBytes = 1 << 20
	mapBodyBytes      = 16 << 20
	ordinaryReadTime  = 2 * time.Minute
	uploadReadTime    = 15 * time.Minute
)

// RequestLimits bounds decoding before business validation, without pre-reading
// unauthenticated uploads or applying a short timeout to long AI responses.
func RequestLimits() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body == nil || c.Request.ContentLength == 0 {
			c.Next()
			return
		}
		limit, readTime := requestBodyBudget(c.Request.Method, c.FullPath())
		controller := http.NewResponseController(c.Writer)
		_ = controller.SetReadDeadline(time.Now().Add(readTime))
		defer func() { _ = controller.SetReadDeadline(time.Time{}) }()
		if limit > 0 {
			if c.Request.ContentLength > limit {
				response.Abort(c, apperr.New(apperr.CodeFileTooLarge, ""))
				return
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

func requestBodyBudget(method, route string) (int64, time.Duration) {
	if (method == http.MethodPost && route == "/api/v1/maps") ||
		(method == http.MethodPut && route == "/api/v1/maps/:uid") {
		return mapBodyBytes, ordinaryReadTime
	}
	if method == http.MethodPost {
		switch route {
		case "/api/v1/ai/generate", "/api/v1/files", "/api/v1/users/me/avatar", "/api/v1/admin/backups/restore/preview":
			// These handlers already set their own bounded MaxBytesReader after
			// authentication. Prefix matches would silently exempt other APIs.
			return 0, uploadReadTime
		}
	}
	return ordinaryBodyBytes, ordinaryReadTime
}
