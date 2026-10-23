package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/handler"
	"github.com/woliubang256/wmind/backend/internal/httpapi"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
	"github.com/woliubang256/wmind/backend/internal/settings"
	"github.com/woliubang256/wmind/backend/internal/storage"
)

// 测试用种子管理员的凭据。
const (
	testAdminEmail    = "admin@example.com"
	testAdminPassword = "admin-correct-horse"
)

// 这个测试是认证链路的端到端验收：真实 SQLite、真实 bcrypt、真实 Cookie。
// 它放在 httpapi 包外，因为装配本来就是 httpapi 的职责（与 cmd/server 同构）。

type authTestServer struct {
	t      *testing.T
	server *httptest.Server
	client *http.Client
	// router 是装配出来的真实路由，OpenAPI 对等性测试要枚举它。
	router http.Handler
	// uploads 是头像落盘的目录，测试用来断言「文件真的写出来了」。
	uploads string
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
	userRepo := sqlite.NewUserRepository(db)
	txManager := sqlite.NewTxManager(db)

	settingsSvc, err := settings.New(sqlite.NewSettingsRepository(db), settings.Config{
		Logger: logger, Tx: txManager,
	})
	if err != nil {
		t.Fatalf("settings.New: %v", err)
	}
	if err := settingsSvc.Load(context.Background()); err != nil {
		t.Fatalf("加载设置: %v", err)
	}

	svc, err := service.NewAuthService(
		userRepo,
		sqlite.NewRefreshTokenRepository(db),
		txManager,
		service.AuthServiceConfig{
			TwoFactor: sqlite.NewTwoFactorRepository(db), TwoFactorKey: "http-test-encryption-key-long-enough",
			Issuer: issuer, RefreshTTL: 7 * 24 * time.Hour,
			Site: settingsSvc, UserCacheTTL: 60 * time.Second,
		},
	)
	if err != nil {
		t.Fatalf("NewAuthService: %v", err)
	}
	// 固定一个种子管理员，管理接口的测试用它登录。
	// 密码要能过策略（默认最小 8 位）。
	if _, err := svc.SeedAdmin(context.Background(), testAdminEmail, testAdminPassword); err != nil {
		t.Fatalf("SeedAdmin: %v", err)
	}

	uploads := filepath.Join(t.TempDir(), "uploads")
	avatarStore, err := storage.NewLocalStore(uploads, "/uploads")
	if err != nil {
		t.Fatalf("NewLocalStore: %v", err)
	}
	userSvc, err := service.NewUserService(userRepo, service.UserServiceConfig{
		Avatars: avatarStore, Tx: txManager,
	})
	if err != nil {
		t.Fatalf("NewUserService: %v", err)
	}

	adminSvc, err := service.NewAdminService(service.AdminServiceConfig{
		Users: userRepo, Tokens: sqlite.NewRefreshTokenRepository(db),
		Audit: sqlite.NewAuditRepository(db), Site: settingsSvc,
		Invalidator: svc, Tx: txManager, Logger: logger,
	})
	if err != nil {
		t.Fatalf("NewAdminService: %v", err)
	}

	// 导图服务：Limits 传真实 settings，这样「导图数量上限」也是真的从
	// 站点设置里读出来的（默认 0 = 不限），测试不会因为上限差异而漂移。
	mapSvc, err := service.NewMapService(service.MapServiceConfig{
		Maps: sqlite.NewMapRepository(db), Limits: settingsSvc,
	})
	if err != nil {
		t.Fatalf("NewMapService: %v", err)
	}

	themeSvc, err := service.NewThemeService(service.ThemeServiceConfig{
		Themes: sqlite.NewThemeRepository(db),
	})
	if err != nil {
		t.Fatalf("NewThemeService: %v", err)
	}

	templateSvc, err := service.NewTemplateService(service.TemplateServiceConfig{
		Templates: sqlite.NewTemplateRepository(db), Maps: sqlite.NewMapRepository(db),
		Policy: settingsSvc,
	})
	if err != nil {
		t.Fatalf("NewTemplateService: %v", err)
	}

	fileSvc, err := service.NewFileService(service.FileServiceConfig{Store: avatarStore})
	if err != nil {
		t.Fatalf("NewFileService: %v", err)
	}

	// 分享服务：Policy 传真实 settings，这样「关闭分享」这类站点开关在测试里
	// 也是真的生效的（验收标准 11 就是靠它验的）。
	shareTokens, err := auth.NewShareTokenIssuer("http-test-secret-that-is-long-enough", 30*time.Minute)
	if err != nil {
		t.Fatalf("NewShareTokenIssuer: %v", err)
	}
	shareSvc, err := service.NewShareService(service.ShareServiceConfig{
		Shares: sqlite.NewShareRepository(db), Maps: sqlite.NewMapRepository(db),
		Policy: settingsSvc, Tokens: shareTokens,
		Views: service.NewViewDeduper(30*time.Minute, nil),
	})
	if err != nil {
		t.Fatalf("NewShareService: %v", err)
	}

	cookie := handler.DefaultCookieConfig(false, 7*24*time.Hour)
	router := httpapi.NewRouter(httpapi.Deps{
		Config: &config.Config{
			Env:  config.EnvDevelopment,
			Auth: config.Auth{JWTSecret: "http-test-secret-that-is-long-enough", AccessTTL: 15 * time.Minute, RefreshTTL: 7 * 24 * time.Hour},
			// 与 main 一样：静态路由从 Storage.Dir 取目录，必须与 store 的
			// 目录是同一个，否则上传成功但取不到文件。
			Storage: config.Storage{Dir: uploads},
		},
		Logger:           logger,
		Auth:             handler.NewAuthHandler(svc, cookie, nil),
		Sessions:         svc,
		RegistrationOpen: settingsSvc.RegistrationEnabled,
		Users:            handler.NewUserHandler(userSvc, svc, cookie.Name, service.DefaultMaxAvatarBytes),
		Site:             handler.NewSiteHandler(settingsSvc, "test-version"),
		AdminSettings:    handler.NewAdminSettingsHandler(settingsSvc, adminSvc),
		Admin:            handler.NewAdminHandler(adminSvc),
		Maps:             handler.NewMapHandler(mapSvc),
		Themes:           handler.NewThemeHandler(themeSvc),
		Templates:        handler.NewTemplateHandler(templateSvc),
		Files:            handler.NewFileHandler(fileSvc),
		Shares:           handler.NewShareHandler(shareSvc, settingsSvc, adminSvc),
	})

	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("创建 Cookie jar: %v", err)
	}
	return &authTestServer{
		t: t, server: server, router: router, uploads: uploads,
		client: &http.Client{Jar: jar, Timeout: 10 * time.Second},
	}
}

// apiResponse 是响应的解析结果。
//
// data 是「对象或数组」两种形态：单条资源是对象，列表是数组。所以不能直接
// 把 data 声明成 map——那样列表响应会解析失败。用自定义 UnmarshalJSON
// 把两种形态分别落到 Data / Items，调用点按需取。
type apiResponse struct {
	Data       map[string]any
	Items      []map[string]any
	Pagination *struct {
		Page       int   `json:"page"`
		PageSize   int   `json:"pageSize"`
		Total      int64 `json:"total"`
		TotalPages int   `json:"totalPages"`
	}
	Error *struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	}
}

func (r *apiResponse) UnmarshalJSON(raw []byte) error {
	var envelope struct {
		Data       json.RawMessage `json:"data"`
		Pagination *struct {
			Page       int   `json:"page"`
			PageSize   int   `json:"pageSize"`
			Total      int64 `json:"total"`
			TotalPages int   `json:"totalPages"`
		} `json:"pagination"`
		Error *struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	r.Pagination = envelope.Pagination
	r.Error = envelope.Error
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return nil
	}
	if envelope.Data[0] == '[' {
		return json.Unmarshal(envelope.Data, &r.Items)
	}
	return json.Unmarshal(envelope.Data, &r.Data)
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

func TestRegisterRateLimit(t *testing.T) {
	s := newAuthTestServer(t)

	// 策略：3 次/小时（docs/04 §3.1）。前三次放行，第四次 429。
	for i, name := range []string{"reg1", "reg2", "reg3"} {
		status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
			"username": name, "email": name + "@example.com", "password": "correct-horse",
		})
		if status != http.StatusCreated {
			t.Fatalf("第 %d 次注册 = %d %#v", i+1, status, body.Error)
		}
	}

	status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "reg4", "email": "reg4@example.com", "password": "correct-horse",
	})
	if status != http.StatusTooManyRequests || body.Error.Code != "RATE_LIMITED" {
		t.Fatalf("超限注册 = %d %#v; 期望 429 RATE_LIMITED", status, body.Error)
	}
	if body.Error.Details["retryAfter"] == nil {
		t.Fatalf("限流响应应带 retryAfter: %#v", body.Error.Details)
	}
}

// TestRegisterClosedOverHTTP 验「关站之后，注册入口与注册接口一起关掉」。
//
// 三条断言各自对应一个曾经会出错的点：
//
//  1. 公开配置要立刻反映 false，否则登录页还会挂着「立即注册」；
//  2. 接口返回 REGISTRATION_CLOSED（403），而不是让它撞上限流器报 429；
//  3. 关站期间的探测**不消耗**注册配额——重开之后第一次注册必须成功。
//     这条是最容易漏的：把闸门挂在限流器后面，前两条都能过，只有这条会红。
func TestRegisterClosedOverHTTP(t *testing.T) {
	s := newAuthTestServer(t)

	token := s.loginAs(testAdminEmail, testAdminPassword)
	status, body := s.do(http.MethodPut, "/api/v1/admin/settings", token, map[string]any{
		"auth.registration_enabled": false,
	})
	if status != http.StatusOK {
		t.Fatalf("关闭注册 = %d %#v", status, body.Error)
	}

	_, site := s.do(http.MethodGet, "/api/v1/site/config", "", nil)
	if site.Data["registrationEnabled"] != false {
		t.Fatalf("关闭后公开配置仍为开放: %#v", site.Data["registrationEnabled"])
	}

	// 打 5 次：限流配额是 3 次/小时，只要闸门排在限流器之后，第 4 次就是 429。
	for i := 1; i <= 5; i++ {
		status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
			"username": "closed" + strconv.Itoa(i), "email": "closed" + strconv.Itoa(i) + "@example.com",
			"password": "correct-horse",
		})
		if status != http.StatusForbidden || body.Error.Code != "REGISTRATION_CLOSED" {
			t.Fatalf("第 %d 次关站注册 = %d %#v; 期望 403 REGISTRATION_CLOSED", i, status, body.Error)
		}
	}

	// 重新开站：配额没被上面的探测吃掉，第一次注册就该成功。
	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", token, map[string]any{
		"auth.registration_enabled": true,
	}); status != http.StatusOK {
		t.Fatalf("重新开放注册 = %d %#v", status, body.Error)
	}
	if status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "reopened", "email": "reopened@example.com", "password": "correct-horse",
	}); status != http.StatusCreated {
		t.Fatalf("重开注册后注册 = %d %#v; 关站期间的探测不该消耗限流配额", status, body.Error)
	}
}

func TestLoginLockoutOverHTTP(t *testing.T) {
	s := newAuthTestServer(t)

	if status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "carol", "email": "carol@example.com", "password": "correct-horse",
	}); status != http.StatusCreated {
		t.Fatalf("注册 = %d %#v", status, body.Error)
	}

	// 连续 5 次密码错误：前 4 次 401，第 5 次 429。
	for i := 1; i <= 4; i++ {
		status, body := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
			"identifier": "carol", "password": "wrong-password",
		})
		if status != http.StatusUnauthorized || body.Error.Code != "AUTH_INVALID_CREDENTIALS" {
			t.Fatalf("第 %d 次失败 = %d %#v", i, status, body.Error)
		}
	}
	status, body := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "carol", "password": "wrong-password",
	})
	if status != http.StatusTooManyRequests || body.Error.Code != "AUTH_TOO_MANY_ATTEMPTS" {
		t.Fatalf("第 5 次失败 = %d %#v; 期望 429 AUTH_TOO_MANY_ATTEMPTS", status, body.Error)
	}

	// 锁定期内正确密码也被拒。
	status, body = s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "carol", "password": "correct-horse",
	})
	if status != http.StatusTooManyRequests {
		t.Fatalf("锁定期间正确密码 = %d %#v", status, body.Error)
	}
}
