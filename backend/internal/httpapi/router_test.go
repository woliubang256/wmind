package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	idgen "github.com/woliubang256/wmind/backend/internal/pkg/id"
)

func TestMain(m *testing.M) {
	// 否则每建一个 router 都会把路由表打到 stdout，测试输出会被淹没。
	gin.SetMode(gin.TestMode)
	os.Exit(m.Run())
}

// envelope 是测试用的响应体视图，字段比 response.Envelope 少——
// 只解出断言需要的部分。
type envelope struct {
	Data struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	} `json:"data"`
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
	RequestID string `json:"requestId"`
}

func testDeps(checks ...ReadyCheck) Deps {
	return Deps{
		Config: &config.Config{
			Env:         config.EnvDevelopment,
			Addr:        ":0",
			LogLevel:    "error",
			CORSOrigins: []string{"http://localhost:5173"},
		},
		// 测试里不需要访问日志，丢弃即可。
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Ready:  checks,
	}
}

func do(t *testing.T, deps Deps, method, target string, headers map[string]string) (*httptest.ResponseRecorder, envelope) {
	t.Helper()

	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	NewRouter(deps).ServeHTTP(rec, req)

	var body envelope
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("响应体不是合法 JSON: %v\n%s", err, rec.Body.String())
		}
	}
	return rec, body
}

func TestHealthLiveReturnsEnvelope(t *testing.T) {
	rec, body := do(t, testDeps(), http.MethodGet, "/api/v1/health/live", nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}
	if body.Data.Status != "ok" {
		t.Fatalf("data.status 期望 ok，实际 %q", body.Data.Status)
	}
	if body.RequestID == "" {
		t.Fatal("成功响应也必须带 requestId")
	}
}

// 存活探针不能依赖下游：数据库抖动时若它返回 503，编排器会反复重启一个
// 本来健康的容器，把小故障放大成不可用。
func TestHealthLiveIgnoresFailingDependency(t *testing.T) {
	failing := ReadyCheck{Name: "database", Ping: func(context.Context) error {
		return errors.New("connection refused")
	}}

	rec, _ := do(t, testDeps(failing), http.MethodGet, "/api/v1/health/live", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("存活探针不应受依赖影响，实际 %d", rec.Code)
	}
}

func TestHealthReadyReportsPerCheckResult(t *testing.T) {
	checks := []ReadyCheck{
		{Name: "database", Ping: func(context.Context) error { return nil }},
		{Name: "storage", Ping: func(context.Context) error { return errors.New("read-only file system") }},
	}

	rec, body := do(t, testDeps(checks...), http.MethodGet, "/api/v1/health/ready", nil)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("有检查项失败时应返回 503，实际 %d", rec.Code)
	}
	if body.Error.Code != "SERVICE_UNAVAILABLE" {
		t.Fatalf("错误码期望 SERVICE_UNAVAILABLE，实际 %q", body.Error.Code)
	}
	// 逐项结果要能直接看出是哪一项挂了，不必翻日志。
	gotChecks, ok := body.Error.Details["checks"].(map[string]any)
	if !ok {
		t.Fatalf("details.checks 缺失或类型不符: %#v", body.Error.Details)
	}
	if gotChecks["database"] != "ok" || gotChecks["storage"] != "error" {
		t.Fatalf("逐项结果不符: %#v", gotChecks)
	}
}

func TestHealthReadyPassesWhenAllChecksSucceed(t *testing.T) {
	checks := []ReadyCheck{
		{Name: "database", Ping: func(context.Context) error { return nil }},
	}

	rec, body := do(t, testDeps(checks...), http.MethodGet, "/api/v1/health/ready", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}
	if body.Data.Checks["database"] != "ok" {
		t.Fatalf("checks 内容不符: %#v", body.Data.Checks)
	}
}

// gin 默认对未注册路由返回纯文本 "404 page not found"，与其它接口的信封
// 格式不一致，会逼前端多写一条特殊分支。
func TestUnknownRouteReturnsErrorEnvelope(t *testing.T) {
	rec, body := do(t, testDeps(), http.MethodGet, "/api/v1/does-not-exist", nil)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("期望 404，实际 %d", rec.Code)
	}
	if body.Error.Code != "RESOURCE_NOT_FOUND" {
		t.Fatalf("错误码期望 RESOURCE_NOT_FOUND，实际 %q", body.Error.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("Content-Type 期望 JSON，实际 %q", ct)
	}
}

func TestMethodNotAllowedReturnsErrorEnvelope(t *testing.T) {
	rec, body := do(t, testDeps(), http.MethodDelete, "/api/v1/health/live", nil)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("期望 404（与未注册路由统一，不泄露路由是否存在），实际 %d", rec.Code)
	}
	if body.Error.Code != "RESOURCE_NOT_FOUND" {
		t.Fatalf("错误码期望 RESOURCE_NOT_FOUND，实际 %q", body.Error.Code)
	}
}

func TestRequestIDIsGeneratedAndEchoed(t *testing.T) {
	rec, body := do(t, testDeps(), http.MethodGet, "/api/v1/health/live", nil)

	header := rec.Header().Get(middleware.HeaderRequestID)
	if header == "" {
		t.Fatal("响应头应带 X-Request-Id")
	}
	if !idgen.Valid(header) {
		t.Fatalf("X-Request-Id 应为合法 ULID，实际 %q", header)
	}
	if body.RequestID != header {
		t.Fatalf("响应头与响应体的 requestId 应一致: %q vs %q", header, body.RequestID)
	}
}

func TestRequestIDPassesThroughValidUpstreamID(t *testing.T) {
	upstream := idgen.New()

	rec, _ := do(t, testDeps(), http.MethodGet, "/api/v1/health/live", map[string]string{
		middleware.HeaderRequestID: upstream,
	})

	if got := rec.Header().Get(middleware.HeaderRequestID); got != upstream {
		t.Fatalf("合法上游 ID 应透传，期望 %q 实际 %q", upstream, got)
	}
}

// 透传是有条件的：不校验的话，外部可以把换行、超长字符串塞进日志。
func TestRequestIDRejectsInjectedValue(t *testing.T) {
	injected := "not-a-ulid\nlevel=ERROR msg=伪造日志"

	rec, _ := do(t, testDeps(), http.MethodGet, "/api/v1/health/live", map[string]string{
		middleware.HeaderRequestID: injected,
	})

	got := rec.Header().Get(middleware.HeaderRequestID)
	if got == injected {
		t.Fatal("非法 X-Request-Id 不应被透传")
	}
	if !idgen.Valid(got) {
		t.Fatalf("应回退为服务端生成的合法 ULID，实际 %q", got)
	}
}

func TestCORSOnlyEchoesAllowedOrigin(t *testing.T) {
	t.Run("允许列表内", func(t *testing.T) {
		rec, _ := do(t, testDeps(), http.MethodGet, "/api/v1/health/live", map[string]string{
			"Origin": "http://localhost:5173",
		})
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
			t.Fatalf("应回显具体来源，实际 %q", got)
		}
		// 带凭据的跨域请求必须声明 Vary，否则中间缓存会把响应串给别的来源。
		if v := rec.Header().Get("Vary"); !strings.Contains(v, "Origin") {
			t.Fatalf("应声明 Vary: Origin，实际 %q", v)
		}
	})

	t.Run("允许列表外", func(t *testing.T) {
		rec, _ := do(t, testDeps(), http.MethodGet, "/api/v1/health/live", map[string]string{
			"Origin": "http://evil.example",
		})
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("未授权来源不应拿到 CORS 头，实际 %q", got)
		}
	})
}

func TestCORSPreflightReturns204(t *testing.T) {
	rec, _ := do(t, testDeps(), http.MethodOptions, "/api/v1/health/live", map[string]string{
		"Origin":                        "http://localhost:5173",
		"Access-Control-Request-Method": "GET",
	})

	if rec.Code != http.StatusNoContent {
		t.Fatalf("预检期望 204，实际 %d", rec.Code)
	}
	// 刷新令牌走 httpOnly Cookie，必须允许携带凭据。
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("应允许携带凭据，实际 %q", got)
	}
}
