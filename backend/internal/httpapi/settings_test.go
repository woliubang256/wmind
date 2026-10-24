package httpapi_test

import (
	"net/http"
	"testing"
)

// loginAs 用账号密码登录并返回访问令牌。
func (s *authTestServer) loginAs(identifier, password string) string {
	s.t.Helper()
	status, body := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": identifier, "password": password,
	})
	if status != http.StatusOK {
		s.t.Fatalf("登录 %s = %d %#v", identifier, status, body.Error)
	}
	token, _ := body.Data["accessToken"].(string)
	if token == "" {
		s.t.Fatalf("登录 %s 没有返回访问令牌", identifier)
	}
	return token
}

func TestSiteConfigIsPublic(t *testing.T) {
	s := newAuthTestServer(t)

	// 未登录可读：登录页要在拿到令牌之前就知道注册是否开放。
	status, body := s.do(http.MethodGet, "/api/v1/site/config", "", nil)
	if status != http.StatusOK {
		t.Fatalf("site/config = %d %#v", status, body.Error)
	}
	if body.Data["siteName"] != "wmind" {
		t.Fatalf("siteName = %#v", body.Data["siteName"])
	}
	if body.Data["registrationEnabled"] != true {
		t.Fatalf("默认应开放注册: %#v", body.Data)
	}
	if body.Data["passwordMinLength"] != float64(8) {
		t.Fatalf("passwordMinLength = %#v", body.Data["passwordMinLength"])
	}
	if body.Data["version"] != "test-version" {
		t.Fatalf("version = %#v", body.Data["version"])
	}
	if body.Data["shareDefaultExpireDays"] != float64(7) || body.Data["shareDefaultAllowDownload"] != false {
		t.Fatalf("分享默认应为 7 天且不允许下载: %#v", body.Data)
	}
	// 敏感项不能出现在公开响应里。
	if _, ok := body.Data["loginMaxAttempts"]; ok {
		t.Fatalf("公开配置泄露了敏感项: %#v", body.Data)
	}
}

func TestAdminSettingsRequiresAdmin(t *testing.T) {
	s := newAuthTestServer(t)

	// 1. 未登录 → 401。
	if status, body := s.do(http.MethodGet, "/api/v1/admin/settings", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("未登录读设置 = %d %#v", status, body.Error)
	}

	// 2. 普通用户 → 403 AUTH_FORBIDDEN。
	userToken := s.registerUser("eve")
	status, body := s.do(http.MethodGet, "/api/v1/admin/settings", userToken, nil)
	if status != http.StatusForbidden || body.Error.Code != "AUTH_FORBIDDEN" {
		t.Fatalf("普通用户读设置 = %d %#v", status, body.Error)
	}
	// 写也一样，不能因为「读被拒了」就假设写被拒了。
	status, body = s.do(http.MethodPut, "/api/v1/admin/settings", userToken, map[string]any{
		"site.name": "被篡改",
	})
	if status != http.StatusForbidden {
		t.Fatalf("普通用户写设置 = %d %#v", status, body.Error)
	}

	// 3. 管理员 → 200，返回全量键（含敏感项）。
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)
	status, body = s.do(http.MethodGet, "/api/v1/admin/settings", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("管理员读设置 = %d %#v", status, body.Error)
	}
	for _, key := range []string{"site.name", "auth.registration_enabled", "auth.login_max_attempts", "limit.upload_max_mb"} {
		if _, ok := body.Data[key]; !ok {
			t.Fatalf("管理员设置里缺少 %s", key)
		}
	}
}

func TestAdminSettingsUpdateTakesEffect(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	// 1. 关闭注册 + 改站点名。
	status, body := s.do(http.MethodPut, "/api/v1/admin/settings", adminToken, map[string]any{
		"site.name":                 "团队导图",
		"auth.registration_enabled": false,
	})
	if status != http.StatusOK {
		t.Fatalf("改设置 = %d %#v", status, body.Error)
	}
	if body.Data["site.name"] != "团队导图" || body.Data["auth.registration_enabled"] != false {
		t.Fatalf("返回的设置没跟上: %#v", body.Data)
	}

	// 2. 公开配置立刻反映改动（不需要重启）。
	status, body = s.do(http.MethodGet, "/api/v1/site/config", "", nil)
	if status != http.StatusOK {
		t.Fatalf("site/config = %d", status)
	}
	if body.Data["registrationEnabled"] != false || body.Data["siteName"] != "团队导图" {
		t.Fatalf("公开配置没跟上: %#v", body.Data)
	}

	// 3. 注册接口直接返回 403 REGISTRATION_CLOSED（验收标准 1）。
	status, body = s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "frank", "email": "frank@example.com", "password": "correct-horse",
	})
	if status != http.StatusForbidden || body.Error.Code != "REGISTRATION_CLOSED" {
		t.Fatalf("关闭注册后注册 = %d %#v", status, body.Error)
	}

	// 4. 重新打开后可以注册。
	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", adminToken, map[string]any{
		"auth.registration_enabled": true,
	}); status != http.StatusOK {
		t.Fatalf("重新开放注册 = %d %#v", status, body.Error)
	}
	if status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": "frank", "email": "frank@example.com", "password": "correct-horse",
	}); status != http.StatusCreated {
		t.Fatalf("重新开放后注册 = %d %#v", status, body.Error)
	}
}

func TestAdminSettingsRejectsInvalidPatch(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	cases := []struct {
		name  string
		patch map[string]any
		key   string
	}{
		{"未知键", map[string]any{"site.unknown": "x"}, "site.unknown"},
		{"类型不符", map[string]any{"auth.registration_enabled": "false"}, "auth.registration_enabled"},
		{"整数越界", map[string]any{"auth.password_min_length": 3}, "auth.password_min_length"},
		{"小数", map[string]any{"limit.upload_max_mb": 2.5}, "limit.upload_max_mb"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := s.do(http.MethodPut, "/api/v1/admin/settings", adminToken, tc.patch)
			if status != http.StatusUnprocessableEntity || body.Error.Code != "SETTINGS_INVALID" {
				t.Fatalf("非法设置 = %d %#v", status, body.Error)
			}
			fields, _ := body.Error.Details["fields"].(map[string]any)
			if fields[tc.key] == nil {
				t.Fatalf("字段错误应指向 %s: %#v", tc.key, body.Error.Details)
			}
		})
	}

	// 非法请求不该改动任何设置。
	status, body := s.do(http.MethodGet, "/api/v1/admin/settings", adminToken, nil)
	if status != http.StatusOK || body.Data["auth.password_min_length"] != float64(8) {
		t.Fatalf("非法请求后设置被改动了: %#v", body.Data)
	}
}

func TestAdminSettingsRejectsMalformedBody(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	// 数组不是对象。
	status, body := s.do(http.MethodPut, "/api/v1/admin/settings", adminToken, []string{"site.name"})
	if status != http.StatusBadRequest || body.Error.Code != "BAD_REQUEST" {
		t.Fatalf("数组请求体 = %d %#v", status, body.Error)
	}
}
