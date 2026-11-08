package localserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const testToken = "0123456789abcdef0123456789abcdef"

func newHandler(t *testing.T, cfg Config) http.Handler {
	t.Helper()
	if cfg.API == nil {
		cfg.API = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("api"))
		})
	}
	if cfg.Token == "" {
		cfg.Token = testToken
	}
	if cfg.Mode == "" {
		cfg.Mode = "local"
	}
	h, err := New(cfg)
	if err != nil {
		t.Fatalf("组装失败: %v", err)
	}
	return h
}

func get(h http.Handler, path string, headers map[string]string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// 首屏导航必须能拿到令牌 cookie，否则用户永远进不去。
func TestDocumentNavigationIssuesToken(t *testing.T) {
	h := newHandler(t, Config{})
	rec := get(h, "/", map[string]string{"Sec-Fetch-Dest": "document"})

	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "window.__WMIND__") {
		t.Fatalf("占位页没有注入运行时配置: %s", rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName || cookies[0].Value != testToken {
		t.Fatalf("没有下发令牌 cookie: %+v", cookies)
	}
	if !cookies[0].HttpOnly {
		t.Fatal("令牌 cookie 必须是 HttpOnly")
	}
}

// 令牌是唯一的边界：没有 cookie 的 API 请求一律拒绝，哪怕它来自本机。
func TestAPIRequiresToken(t *testing.T) {
	h := newHandler(t, Config{})

	rec := get(h, "/api/v1/health/live", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("无令牌期望 403，实际 %d", rec.Code)
	}

	rec = get(h, "/api/v1/health/live", nil, &http.Cookie{Name: CookieName, Value: "wrong-token-value-1234"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("错误令牌期望 403，实际 %d", rec.Code)
	}

	rec = get(h, "/api/v1/health/live", nil, &http.Cookie{Name: CookieName, Value: testToken})
	if rec.Code != http.StatusOK || rec.Body.String() != "api" {
		t.Fatalf("正确令牌应到达后端: %d %q", rec.Code, rec.Body.String())
	}
}

// 静态资源不能被「首屏放行」顺带放过，否则守卫对脚本、样式失效。
func TestStaticAssetRequiresToken(t *testing.T) {
	static := fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><html><head></head><body>app</body></html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	h := newHandler(t, Config{Static: static})

	rec := get(h, "/assets/app.js", map[string]string{"Sec-Fetch-Dest": "script"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("无令牌的脚本请求期望 403，实际 %d", rec.Code)
	}

	rec = get(h, "/assets/app.js", map[string]string{"Sec-Fetch-Dest": "script"}, &http.Cookie{Name: CookieName, Value: testToken})
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("带令牌应返回脚本: %d %q", rec.Code, rec.Body.String())
	}
}

// 前端是 SPA：无扩展名的路径必须回落到 index.html，且同样要注入运行时配置。
func TestSPAFallbackServesInjectedIndex(t *testing.T) {
	static := fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><html><head><title>wmind</title></head><body>app</body></html>")},
	}
	h := newHandler(t, Config{Static: static, Version: "1.0.0"})

	rec := get(h, "/maps/abc", map[string]string{"Sec-Fetch-Dest": "document"})
	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `window.__WMIND__={"apiBase":"/api/v1","mode":"local","version":"1.0.0"}`) {
		t.Fatalf("注入内容不符合预期: %s", body)
	}
	if !strings.Contains(body, "</head>") || strings.Index(body, "window.__WMIND__") > strings.Index(body, "</head>") {
		t.Fatalf("脚本必须在 </head> 之前: %s", body)
	}
}

// 本地模式没有登录页：令牌必须随首屏一起注入，且只在配置里给了才注入。
func TestRuntimeScriptInjectsAuthToken(t *testing.T) {
	static := fstest.MapFS{
		"index.html": {Data: []byte("<html><head></head><body></body></html>")},
	}
	h := newHandler(t, Config{Static: static, AuthToken: "jwt-token-value"})
	body := get(h, "/", map[string]string{"Sec-Fetch-Dest": "document"}).Body.String()
	if !strings.Contains(body, `"authToken":"jwt-token-value"`) {
		t.Fatalf("没有注入访问令牌: %s", body)
	}

	withoutToken := newHandler(t, Config{Static: static})
	body = get(withoutToken, "/", map[string]string{"Sec-Fetch-Dest": "document"}).Body.String()
	if strings.Contains(body, "authToken") {
		t.Fatalf("没有令牌时不应注入该字段: %s", body)
	}
}

func TestNewRejectsMissingParts(t *testing.T) {
	if _, err := New(Config{Token: testToken}); err == nil {
		t.Fatal("缺少 API handler 应当报错")
	}
	if _, err := New(Config{API: http.NotFoundHandler(), Token: "short"}); err == nil {
		t.Fatal("过短的令牌应当报错")
	}
}
