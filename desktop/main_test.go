package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/desktop/internal/localmode"
	"github.com/woliubang256/wmind/backend/desktop/internal/localserver"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newLocal(t *testing.T) *localInstance {
	t.Helper()
	paths, err := localmode.ResolvePaths(t.TempDir())
	if err != nil {
		t.Fatalf("解析数据目录失败: %v", err)
	}
	local, err := assembleLocal(context.Background(), paths, testLogger(), "1.0.0", localeInfo{Locale: "zh-Hans", Preferred: []string{"zh-Hans-CN", "en"}})
	if err != nil {
		t.Fatalf("装配本地模式失败: %v", err)
	}
	t.Cleanup(local.Close)
	return local
}

func do(t *testing.T, local *localInstance, path, dest string, withShellCookie bool, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if dest != "" {
		req.Header.Set("Sec-Fetch-Dest", dest)
	}
	if withShellCookie {
		req.AddCookie(&http.Cookie{Name: localserver.CookieName, Value: local.ShellToken})
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	local.Handler.ServeHTTP(rec, req)
	return rec
}

// 整条链必须真的能跑：本地库迁移 → 后端路由 → 本地用户 → 令牌鉴权。
// 这是桌面版「打开就能用」的最低保证。
func TestLocalModeServesAuthenticatedAPI(t *testing.T) {
	local := newLocal(t)

	rec := do(t, local, "/api/v1/maps", "empty", true, local.AccessToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("带本地令牌访问 /maps 期望 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"data"`) {
		t.Fatalf("响应不是预期的列表信封: %s", rec.Body.String())
	}

	// 没有令牌：401，而不是 200。本地模式没有登录页，但接口不是无鉴权的。
	rec = do(t, local, "/api/v1/maps", "empty", true, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无令牌访问 /maps 期望 401，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// 首屏必须把访问令牌注入页面：前端靠它免登录。
func TestLocalModeInjectsAccessTokenIntoDocument(t *testing.T) {
	local := newLocal(t)

	rec := do(t, local, "/", "document", false, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("首屏期望 200，实际 %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"authToken":"`+local.AccessToken+`"`) {
		t.Fatalf("首屏没有注入访问令牌: %s", body)
	}
	if !strings.Contains(body, `"mode":"local"`) {
		t.Fatalf("首屏没有注入运行模式: %s", body)
	}

	// 没有壳令牌的 API 请求一律拒绝，哪怕它来自本机回环。
	rec = do(t, local, "/api/v1/maps", "document", false, local.AccessToken)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("缺少壳令牌期望 403，实际 %d", rec.Code)
	}
}

// 第二次装配必须复用同一个本地用户与同一份密钥：否则每次启动都会多出一个
// 用户，页面里的令牌也会换人。
func TestLocalModeReusesUserAndSecrets(t *testing.T) {
	root := t.TempDir()
	paths, err := localmode.ResolvePaths(root)
	if err != nil {
		t.Fatalf("解析数据目录失败: %v", err)
	}

	first, err := assembleLocal(context.Background(), paths, testLogger(), "1.0.0", localeInfo{Locale: "zh-Hans", Preferred: []string{"zh-Hans-CN", "en"}})
	if err != nil {
		t.Fatalf("首次装配失败: %v", err)
	}
	first.Close()

	second, err := assembleLocal(context.Background(), paths, testLogger(), "1.0.0", localeInfo{Locale: "zh-Hans", Preferred: []string{"zh-Hans-CN", "en"}})
	if err != nil {
		t.Fatalf("再次装配失败: %v", err)
	}
	defer second.Close()

	rec := do(t, second, "/api/v1/auth/me", "empty", true, second.AccessToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("重启后令牌应仍然有效，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), localmode.LocalEmail) {
		t.Fatalf("重启后应当还是同一个本地用户: %s", rec.Body.String())
	}
}
