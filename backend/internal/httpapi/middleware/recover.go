package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// Recover 捕获 panic，记录堆栈，返回 INTERNAL_ERROR。
//
// 必须是中间件链的第一环：任何在它之前注册的中间件一旦 panic，进程就会
// 直接挂掉。
func Recover(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}

			// http.ErrAbortHandler 是标准库约定的「静默中止」信号
			// （http.Server 内部与 reverse proxy 会用到），不是错误。
			if rec == http.ErrAbortHandler {
				panic(rec)
			}

			log.ErrorContext(c.Request.Context(), "请求处理 panic",
				"panic", rec,
				"method", c.Request.Method,
				"path", c.Request.URL.Path,
				"requestId", RequestIDFrom(c),
				"stack", string(debug.Stack()),
			)

			response.Abort(c, apperr.New(apperr.CodeInternalError, ""))
		}()

		c.Next()
	}
}
