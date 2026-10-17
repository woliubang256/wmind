package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/handler"
	"github.com/woliubang256/wmind/backend/internal/httpapi"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// 这个测试是认证链路的端到端验收：真实 SQLite、真实 bcrypt、真实 Cookie。
// 它放在 httpapi 包外，因为装配本来就是 httpapi 的职责（与 cmd/server 同构）。

type authTestServer struct {
	t      *testing.T
	server *httptest.Server
	client *http.Client
}

func newAuthTestServer(t *testing.T) *authTestServer {
	t.Helper()

	db, err := sqlite.Open(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := migrate.Up(config.DriverSQLite, db, logger); err != nil {
		t.Fatalf("应用迁移: %v", err)
	}

	issuer, err := auth.NewTokenIssuer("http-test-secret-that-is-long-enough", 15*time.Minute)
	if err != nil {
		t.Fatalf("NewTokenIssuer: %v", err)
	}
	svc, err := service.NewAuthService(
		sqlite.NewUserRepository(db),
		sqlite.NewRefreshTokenRepository(db),
		sqlite.NewTxManager(db),
		service.AuthServiceConfig{
			Issuer: issuer, RefreshTTL: 7 * 24 * time.Hour,
			Site: service.OpenSiteConfig(), UserCacheTTL: 60 * time.Second,
		},
	)
	if err != nil {
		t.Fatalf("NewAuthService: %v", err)
	}

	router := httpapi.NewRouter(httpapi.Deps{
		Config: &config.Config{
			Env:  config.EnvDevelopment,
			Auth: config.Auth{JWTSecret: "http-test-secret-that-is-long-enough", AccessTTL: 15 * time.Minute, RefreshTTL: 7 * 24 * time.Hour},
		},
		Logger:   logger,
		Auth:     handler.NewAuthHandler(svc, handler.DefaultCookieConfig(false, 7*24*time.Hour)),
		Sessions: svc,
	})

	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("创建 Cookie jar: %v", err)
	}
	return &authTestServer{t: t, server: server, client: &http.Client{Jar: jar, Timeout: 10 * time.Second}}
}

type apiResponse struct {
	Data  map[string]any `json:"data"`
	Error *struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func (s *authTestServer) do(method, path, token string, body any) (int, apiResponse) {
	s.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			s.t.Fatalf("序列化请求: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, s.server.URL+path, reader)
	if err != nil {
		s.t.Fatalf("构造请求: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		s.t.Fatalf("发送请求: %v", err)
	}
	defer resp.Body.Close()

	var parsed apiResponse
	if resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			s.t.Fatalf("解析响应 (%d): %v", resp.StatusCode, err)
		}
	}
	return resp.StatusCode, parsed
}

func TestAuthEndToEnd(t *testing.T) {
	s := newAuthTestServer(t)

	// 1. 注册：201 + 访问令牌 + 刷新 Cookie。
	status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "alice", "email": "alice@example.com",
		"password": "correct-horse", "nickname": "Alice",
	})
	if status != http.StatusCreated {
		t.Fatalf("注册状态 = %d; 期望 201（%#v）", status, body.Error)
	}
	token, _ := body.Data["accessToken"].(string)
	if token == "" || body.Data["expiresIn"].(float64) != 900 {
		t.Fatalf("注册响应缺少令牌: %#v", body.Data)
	}
	user, _ := body.Data["user"].(map[string]any)
	if user["username"] != "alice" || user["role"] != "user" {
		t.Fatalf("注册返回的用户不对: %#v", user)
	}

	// 2. 带令牌访问 /auth/me。
	status, body = s.do(http.MethodGet, "/api/v1/auth/me", token, nil)
	if status != http.StatusOK || body.Data["username"] != "alice" {
		t.Fatalf("me = %d %#v", status, body.Data)
	}

	// 3. 不带令牌 → AUTH_TOKEN_INVALID。
	status, body = s.do(http.MethodGet, "/api/v1/auth/me", "", nil)
	if status != http.StatusUnauthorized || body.Error == nil || body.Error.Code != "AUTH_TOKEN_INVALID" {
		t.Fatalf("无令牌 me = %d %#v", status, body.Error)
	}

	// 4. 错误密码 → AUTH_INVALID_CREDENTIALS。
	status, body = s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "alice", "password": "wrong-password",
	})
	if status != http.StatusUnauthorized || body.Error.Code != "AUTH_INVALID_CREDENTIALS" {
		t.Fatalf("错误密码登录 = %d %#v", status, body.Error)
	}

	// 5. 刷新：Cookie 自动带上，返回新的访问令牌。
	status, body = s.do(http.MethodPost, "/api/v1/auth/refresh", "", nil)
	if status != http.StatusOK {
		t.Fatalf("刷新 = %d %#v", status, body.Error)
	}
	refreshed, _ := body.Data["accessToken"].(string)
	if refreshed == "" || refreshed == token {
		t.Fatal("刷新应返回新的访问令牌")
	}

	// 6. 登出 → 204，随后刷新失败（Cookie 已被清掉）。
	status, _ = s.do(http.MethodPost, "/api/v1/auth/logout", "", nil)
	if status != http.StatusNoContent {
		t.Fatalf("登出状态 = %d; 期望 204", status)
	}
	status, body = s.do(http.MethodPost, "/api/v1/auth/refresh", "", nil)
	if status != http.StatusUnauthorized || body.Error.Code != "AUTH_REFRESH_INVALID" {
		t.Fatalf("登出后刷新 = %d %#v", status, body.Error)
	}
}

func TestAuthValidationAndConflicts(t *testing.T) {
	s := newAuthTestServer(t)

	status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "ab", "email": "not-an-email", "password": "short",
	})
	if status != http.StatusUnprocessableEntity || body.Error.Code != "VALIDATION_FAILED" {
		t.Fatalf("非法注册 = %d %#v", status, body.Error)
	}
	fields, _ := body.Error.Details["fields"].(map[string]any)
	for _, key := range []string{"username", "email", "password"} {
		if fields[key] == nil {
			t.Fatalf("缺少字段错误 %q: %#v", key, body.Error.Details)
		}
	}

	if status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "bob", "email": "bob@example.com", "password": "correct-horse",
	}); status != http.StatusCreated {
		t.Fatalf("首次注册 = %d %#v", status, body.Error)
	}

	status, body = s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "bob2", "email": "BOB@example.com", "password": "correct-horse",
	})
	if status != http.StatusConflict || body.Error.Code != "AUTH_EMAIL_TAKEN" {
		t.Fatalf("重复邮箱 = %d %#v", status, body.Error)
	}
}
