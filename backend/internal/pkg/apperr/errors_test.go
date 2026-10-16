package apperr

import (
	"errors"
	"fmt"
	"net/http"
	"testing"
)

// TestHTTPStatusIsOwnedByCode 守住一条契约：HTTP 状态码由错误码唯一决定。
// 若允许调用方各自传状态码，同一个码迟早会在不同接口返回不同状态，
// 前端的错误分支就会开始漂移。
func TestHTTPStatusIsOwnedByCode(t *testing.T) {
	cases := []struct {
		code   Code
		status int
	}{
		{CodeBadRequest, http.StatusBadRequest},
		{CodeAuthTokenExpired, http.StatusUnauthorized},
		{CodeRegistrationClosed, http.StatusForbidden},
		{CodeMapNotFound, http.StatusNotFound},
		{CodeMapVersionConflict, http.StatusConflict},
		{CodeFileTooLarge, http.StatusRequestEntityTooLarge},
		{CodeImportFormatUnsupported, http.StatusUnsupportedMediaType},
		{CodeValidationFailed, http.StatusUnprocessableEntity},
		{CodeRateLimited, http.StatusTooManyRequests},
		{CodeInternalError, http.StatusInternalServerError},
		{CodeServiceUnavailable, http.StatusServiceUnavailable},
	}

	for _, tc := range cases {
		if got := New(tc.code, "").HTTPStatus(); got != tc.status {
			t.Errorf("%s: 期望 %d，实际 %d", tc.code, tc.status, got)
		}
	}
}

// 未登记的错误码不能凭空造出 4xx——宁可 500，也不要让客户端以为是自己错了。
func TestUnknownCodeFallsBackToInternalError(t *testing.T) {
	err := New(Code("NOT_A_REGISTERED_CODE"), "")
	if got := err.HTTPStatus(); got != http.StatusInternalServerError {
		t.Fatalf("未登记的错误码应回落到 500，实际 %d", got)
	}
}

func TestDefaultMessageFilledWhenEmpty(t *testing.T) {
	if got := New(CodeMapNotFound, "").Message; got == "" {
		t.Fatal("空文案应回落到该错误码的默认文案")
	}
	if got := New(CodeMapNotFound, "自定义文案").Message; got != "自定义文案" {
		t.Fatalf("显式文案应被保留，实际 %q", got)
	}
}

func TestFromNormalisesForeignError(t *testing.T) {
	cause := errors.New("pq: relation \"users\" does not exist")

	err := From(cause)
	if err.Code != CodeInternalError {
		t.Fatalf("外部错误应归为 INTERNAL_ERROR，实际 %s", err.Code)
	}
	// 根因必须保留在服务端侧，否则线上无从排查。
	if !errors.Is(err, cause) {
		t.Fatal("根因应当可以通过 errors.Is 追溯")
	}
	// 但客户端看到的文案不能包含内部细节。
	if err.Message == cause.Error() {
		t.Fatalf("客户端文案不应回显内部错误: %q", err.Message)
	}
}

func TestFromPassesThroughAppError(t *testing.T) {
	original := New(CodeMapNotFound, "")
	if got := From(original); got != original {
		t.Fatal("已是 *Error 时应原样返回，不应重新包装")
	}
}

func TestWrapPreservesCauseAndCode(t *testing.T) {
	cause := errors.New("driver: bad connection")
	err := Wrap(CodeServiceUnavailable, cause)

	if err.Code != CodeServiceUnavailable {
		t.Fatalf("错误码应保留，实际 %s", err.Code)
	}
	if !errors.Is(err, cause) {
		t.Fatal("根因应当可追溯")
	}
}

// WithDetail 必须返回新实例：共享同一个 *Error 会让并发请求互相污染 details。
func TestWithDetailDoesNotMutateOriginal(t *testing.T) {
	base := New(CodeMapVersionConflict, "")

	one := base.WithDetail("currentVersion", 12)
	two := base.WithDetail("currentVersion", 7)

	if base.Details != nil {
		t.Fatalf("原实例不应被修改: %#v", base.Details)
	}
	if one.Details["currentVersion"] != 12 {
		t.Fatalf("第一个派生实例的 details 被污染: %#v", one.Details)
	}
	if two.Details["currentVersion"] != 7 {
		t.Fatalf("第二个派生实例的 details 被污染: %#v", two.Details)
	}
}

func TestValidationBuildsFieldErrors(t *testing.T) {
	err := Validation(map[string]string{"email": "邮箱格式不正确"})

	if err.Code != CodeValidationFailed {
		t.Fatalf("错误码应为 %s，实际 %s", CodeValidationFailed, err.Code)
	}
	fields, ok := err.Details["fields"].(map[string]string)
	if !ok {
		t.Fatalf("details.fields 类型不符: %#v", err.Details)
	}
	if fields["email"] != "邮箱格式不正确" {
		t.Fatalf("字段错误未正确写入: %#v", fields)
	}
}

func TestIsMatchesCodeThroughWrapping(t *testing.T) {
	wrapped := fmt.Errorf("保存导图失败: %w", New(CodeMapVersionConflict, ""))

	if !Is(wrapped, CodeMapVersionConflict) {
		t.Fatal("errors.Is 应能穿透包装层匹配错误码")
	}
	if Is(wrapped, CodeMapNotFound) {
		t.Fatal("不应匹配到无关的错误码")
	}
}
