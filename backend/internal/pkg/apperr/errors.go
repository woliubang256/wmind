// Package apperr 定义跨层使用的应用错误。
//
// 放在 pkg 下而不是 httpapi 下，是为了让 service 层也能构造它——
// 若错误类型定义在 httpapi，service 就必须 import 上层包，分层方向就反了。
//
// 本包不依赖 gin，也不依赖任何上层包。
package apperr

import (
	"errors"
	"fmt"
	"net/http"
)

// Error 是可安全返回给客户端的错误。
//
// 它同时携带 HTTP 状态与业务码：状态码由错误码决定（见 codes.go 的登记表），
// 调用方不需要也不应该手写状态码，避免出现「同一个码在 A 处返回 404、
// 在 B 处返回 403」的漂移。
type Error struct {
	Code    Code
	Message string
	Details map[string]any

	cause error
}

// Error 实现 error 接口。cause 一并输出，便于日志里看到根因。
func (e *Error) Error() string {
	if e.cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap 支持 errors.Is / errors.As 穿透到根因。
func (e *Error) Unwrap() error { return e.cause }

// HTTPStatus 返回该错误对应的 HTTP 状态码。
func (e *Error) HTTPStatus() int { return lookup(e.Code).status }

// New 构造一个错误。message 为空时使用该错误码的默认文案。
func New(code Code, message string) *Error {
	return &Error{Code: code, Message: resolveMessage(code, message)}
}

// Newf 构造一个带格式化文案的错误。
func Newf(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Wrap 把一个底层错误包成应用错误，保留根因供日志排查。
func Wrap(code Code, cause error) *Error {
	return &Error{Code: code, Message: lookup(code).message, cause: cause}
}

// Wrapf 在 Wrap 的基础上自定义文案。
func Wrapf(code Code, cause error, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...), cause: cause}
}

// WithDetail 附加一个结构化细节，返回新的错误实例（不修改原对象）。
//
// 细节会原样进入响应的 error.details，**不要放内部实现信息**。
func (e *Error) WithDetail(key string, value any) *Error {
	out := e.clone()
	if out.Details == nil {
		out.Details = make(map[string]any, 1)
	}
	out.Details[key] = value
	return out
}

// WithFieldErrors 附加字段级校验错误，产出 error.details.fields。
func (e *Error) WithFieldErrors(fields map[string]string) *Error {
	return e.WithDetail("fields", fields)
}

func (e *Error) clone() *Error {
	out := *e
	if e.Details != nil {
		out.Details = make(map[string]any, len(e.Details)+1)
		for k, v := range e.Details {
			out.Details[k] = v
		}
	}
	return &out
}

// From 把任意 error 归一为 *Error。
//
// 非 *Error 一律归为 INTERNAL_ERROR 并保留根因：这样 handler 不需要逐个判断
// 类型，也避免把内部错误信息（SQL 片段、路径）泄露给客户端。
func From(err error) *Error {
	if err == nil {
		return nil
	}
	var appErr *Error
	if errors.As(err, &appErr) {
		return appErr
	}
	return &Error{
		Code:    CodeInternalError,
		Message: lookup(CodeInternalError).message,
		cause:   err,
	}
}

// Is 报告 err 链上是否命中了指定错误码。
func Is(err error, code Code) bool {
	var appErr *Error
	return errors.As(err, &appErr) && appErr.Code == code
}

// Validation 是参数校验失败的快捷构造，用于 handler 层。
func Validation(fields map[string]string) *Error {
	return New(CodeValidationFailed, "").WithFieldErrors(fields)
}

func resolveMessage(code Code, message string) string {
	if message != "" {
		return message
	}
	return lookup(code).message
}

// 编译期断言：*Error 必须实现 error。
var _ error = (*Error)(nil)

// 编译期断言：默认状态码取自登记表，不存在「未设置状态」的情况。
var _ = func() bool { return lookup(CodeInternalError).status == http.StatusInternalServerError }
