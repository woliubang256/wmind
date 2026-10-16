// Package response 定义统一的 HTTP 响应信封。
//
// 线上结构（见 docs/04-后端设计与API规范.md §4）：
//
//	成功：{ "data": ..., "pagination": {...}, "requestId": "..." }
//	失败：{ "error": { "code": ..., "message": ..., "details": {...} }, "requestId": "..." }
//
// handler 一律通过本包的函数写响应，不要直接调用 c.JSON——否则信封结构会
// 在几十个 handler 里各写一遍，迟早漂移。
package response

import (
	"log/slog"
	"math"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/reqid"
)

// Envelope 是成功响应的信封。
type Envelope struct {
	Data       any         `json:"data,omitempty"`
	Pagination *Pagination `json:"pagination,omitempty"`
	RequestID  string      `json:"requestId,omitempty"`
}

// ErrorEnvelope 是错误响应的信封。
type ErrorEnvelope struct {
	Error     ErrorBody `json:"error"`
	RequestID string    `json:"requestId,omitempty"`
}

// ErrorBody 是 error 字段的线上结构。
type ErrorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// Pagination 是列表响应的分页信息。
type Pagination struct {
	Page       int   `json:"page"`
	PageSize   int   `json:"pageSize"`
	Total      int64 `json:"total"`
	TotalPages int   `json:"totalPages"`
}

// NewPagination 计算分页信息，totalPages 向上取整。
func NewPagination(page, pageSize int, total int64) Pagination {
	if pageSize <= 0 {
		pageSize = 20
	}
	totalPages := 0
	if total > 0 {
		totalPages = int(math.Ceil(float64(total) / float64(pageSize)))
	}
	return Pagination{Page: page, PageSize: pageSize, Total: total, TotalPages: totalPages}
}

// OK 写入 200 与 data。
func OK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, Envelope{Data: data, RequestID: requestID(c)})
}

// Created 写入 201 与 data。
func Created(c *gin.Context, data any) {
	c.JSON(http.StatusCreated, Envelope{Data: data, RequestID: requestID(c)})
}

// List 写入 200，附带分页信封。
//
// 列表为空时必须序列化成 `[]` 而不是 `null`（见 docs/04 §4 的 API 约定）。
// 调用方负责传非 nil 切片；这里做一次兜底，把 nil 切片换成空切片。
func List(c *gin.Context, data any, p Pagination) {
	if data == nil {
		data = []any{}
	}
	c.JSON(http.StatusOK, Envelope{Data: data, Pagination: &p, RequestID: requestID(c)})
}

// NoContent 写入 204，无响应体。
func NoContent(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

// Fail 把错误渲染为标准错误响应。
//
// 5xx 会额外记一条 error 级日志——客户端只看到「服务器内部错误」，
// 根因必须留在服务端日志里，否则线上无从排查。
func Fail(c *gin.Context, err error) {
	appErr := apperr.From(err)
	if appErr == nil {
		appErr = apperr.New(apperr.CodeInternalError, "")
	}

	if status := appErr.HTTPStatus(); status >= http.StatusInternalServerError {
		slog.ErrorContext(c.Request.Context(), "请求处理失败",
			"code", appErr.Code,
			"status", status,
			"err", appErr,
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
		)
	}

	c.JSON(appErr.HTTPStatus(), ErrorEnvelope{
		Error: ErrorBody{
			Code:    string(appErr.Code),
			Message: appErr.Message,
			Details: appErr.Details,
		},
		RequestID: requestID(c),
	})
}

// Abort 渲染错误并中止后续 handler。
//
// 中间件里用它——普通 handler 直接 return 即可，不需要 Abort。
func Abort(c *gin.Context, err error) {
	c.Abort()
	Fail(c, err)
}

// requestID 返回当前请求的 ID，用于填充响应信封。
//
// 不导出：外部若要读请求 ID，应走 middleware.RequestIDFrom，避免同一件事
// 有两个入口。
func requestID(c *gin.Context) string {
	return reqid.FromContext(c.Request.Context())
}
