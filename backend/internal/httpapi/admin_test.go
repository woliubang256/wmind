package httpapi_test

import (
	"net/http"
	"strings"
	"testing"
)

// 这一组覆盖管理后台的核心约束：谁能进、最后一个管理员不能被弄没、
// 重置密码一次性、禁用立刻生效、审计留痕但不留密码。

func TestAdminRoutesRequireAdminRole(t *testing.T) {
	s := newAuthTestServer(t)
	userToken := s.registerUser("mallory")

	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/admin/users"},
		{http.MethodPost, "/api/v1/admin/users"},
		{http.MethodGet, "/api/v1/admin/stats"},
		{http.MethodGet, "/api/v1/admin/audit-logs"},
		{http.MethodGet, "/api/v1/admin/settings"},
	}
	for _, route := range routes {
		// 未登录 → 401
		if status, _ := s.do(route.method, route.path, "", nil); status != http.StatusUnauthorized {
			t.Fatalf("%s %s 未登录 = %d; 期望 401", route.method, route.path, status)
		}
		// 普通用户 → 403
		status, body := s.do(route.method, route.path, userToken, nil)
		if status != http.StatusForbidden || body.Error.Code != "AUTH_FORBIDDEN" {
			t.Fatalf("%s %s 普通用户 = %d %#v", route.method, route.path, status, body.Error)
		}
	}
}

func TestAdminListAndCreateUser(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)
	s.registerUser("alice")

	// 1. 列表：带分页信封，且含种子管理员与 alice。
	status, body := s.do(http.MethodGet, "/api/v1/admin/users", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("用户列表 = %d %#v", status, body.Error)
	}
	if body.Pagination == nil || body.Pagination.Total < 2 {
		t.Fatalf("列表缺少分页信息或总数不对: %#v", body.Pagination)
	}
	if len(body.Items) < 2 {
		t.Fatalf("列表应含种子管理员与 alice，实际 %d 条", len(body.Items))
	}

	// 2. 关键字搜索。
	status, body = s.do(http.MethodGet, "/api/v1/admin/users?q=alice", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("搜索 = %d %#v", status, body.Error)
	}

	// 3. 创建用户：201，角色可指定。
	status, body = s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "bob", "email": "bob@example.com",
		"password": "correct-horse", "nickname": "Bob", "role": "admin",
	})
	if status != http.StatusCreated {
		t.Fatalf("创建用户 = %d %#v", status, body.Error)
	}
	if body.Data["role"] != "admin" || body.Data["username"] != "bob" {
		t.Fatalf("创建的用户 = %#v", body.Data)
	}

	// 4. 创建时密码同样要过策略。
	status, body = s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "weakling", "email": "weak@example.com", "password": "123",
	})
	fields, _ := body.Error.Details["fields"].(map[string]any)
	if status != http.StatusUnprocessableEntity || fields["password"] == nil {
		t.Fatalf("弱密码创建 = %d %#v", status, body.Error)
	}

	// 5. 重复邮箱 → 409。
	status, body = s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "bob2", "email": "bob@example.com", "password": "correct-horse",
	})
	if status != http.StatusConflict || body.Error.Code != "AUTH_EMAIL_TAKEN" {
		t.Fatalf("重复邮箱 = %d %#v", status, body.Error)
	}

	// 6. 非法角色 → 422。
	status, body = s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "root", "email": "root@example.com",
		"password": "correct-horse", "role": "superuser",
	})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("非法角色 = %d %#v", status, body.Error)
	}
}

func TestAdminDisableUserRevokesAccessImmediately(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	// 用管理员创建一个普通用户，再以该用户身份登录，拿到它的令牌。
	status, body := s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "dave", "email": "dave@example.com",
		"password": "correct-horse", "role": "user",
	})
	if status != http.StatusCreated {
		t.Fatalf("创建 dave = %d %#v", status, body.Error)
	}
	daveUID, _ := body.Data["uid"].(string)
	daveToken := s.loginAs("dave", "correct-horse")

	// 禁用前：能访问 /auth/me。
	if status, _ := s.do(http.MethodGet, "/api/v1/auth/me", daveToken, nil); status != http.StatusOK {
		t.Fatalf("禁用前 me = %d", status)
	}

	// 禁用。
	status, body = s.do(http.MethodPatch, "/api/v1/admin/users/"+daveUID, adminToken, map[string]string{
		"status": "disabled",
	})
	if status != http.StatusOK || body.Data["status"] != "disabled" {
		t.Fatalf("禁用 = %d %#v", status, body.Error)
	}

	// 验收标准 3：已签发的 Access Token 立刻失效。
	status, body = s.do(http.MethodGet, "/api/v1/auth/me", daveToken, nil)
	if status != http.StatusForbidden || body.Error.Code != "AUTH_ACCOUNT_DISABLED" {
		t.Fatalf("禁用后 me = %d %#v; 期望 403 AUTH_ACCOUNT_DISABLED", status, body.Error)
	}

	// 被禁用后也登录不了。
	status, body = s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "dave", "password": "correct-horse",
	})
	if status != http.StatusForbidden || body.Error.Code != "AUTH_ACCOUNT_DISABLED" {
		t.Fatalf("禁用后登录 = %d %#v", status, body.Error)
	}

	// 重新启用后恢复正常。
	if status, body := s.do(http.MethodPatch, "/api/v1/admin/users/"+daveUID, adminToken, map[string]string{
		"status": "active",
	}); status != http.StatusOK {
		t.Fatalf("启用 = %d %#v", status, body.Error)
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "dave", "password": "correct-horse",
	}); status != http.StatusOK {
		t.Fatalf("启用后登录 = %d", status)
	}
}

func TestAdminCannotDemoteOrDeleteLastAdmin(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	// 找到自己的 uid。
	status, body := s.do(http.MethodGet, "/api/v1/admin/users?q=admin", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("查找管理员 = %d %#v", status, body.Error)
	}
	var adminUID string
	for _, user := range body.Items {
		if user["email"] == testAdminEmail {
			adminUID, _ = user["uid"].(string)
		}
	}
	if adminUID == "" {
		t.Fatalf("找不到种子管理员: %#v", body.Data)
	}

	// 唯一的 admin 不能被降级。
	status, body = s.do(http.MethodPatch, "/api/v1/admin/users/"+adminUID, adminToken, map[string]string{
		"role": "user",
	})
	if status != http.StatusConflict || body.Error.Code != "ADMIN_LAST_ADMIN" {
		t.Fatalf("降级最后管理员 = %d %#v", status, body.Error)
	}

	// 唯一的 admin 不能被禁用。
	status, body = s.do(http.MethodPatch, "/api/v1/admin/users/"+adminUID, adminToken, map[string]string{
		"status": "disabled",
	})
	if status != http.StatusConflict || body.Error.Code != "ADMIN_LAST_ADMIN" {
		t.Fatalf("禁用最后管理员 = %d %#v", status, body.Error)
	}

	// 不能删除自己。
	status, body = s.do(http.MethodDelete, "/api/v1/admin/users/"+adminUID, adminToken, nil)
	if status != http.StatusConflict || body.Error.Code != "ADMIN_CANNOT_DELETE_SELF" {
		t.Fatalf("删除自己 = %d %#v", status, body.Error)
	}
}

func TestAdminResetPasswordFlow(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	status, body := s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "erin", "email": "erin@example.com",
		"password": "correct-horse", "role": "user",
	})
	if status != http.StatusCreated {
		t.Fatalf("创建 erin = %d %#v", status, body.Error)
	}
	erinUID, _ := body.Data["uid"].(string)

	// 1. 空请求体 = 随机生成。
	status, body = s.do(http.MethodPost, "/api/v1/admin/users/"+erinUID+"/reset-password", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("重置密码 = %d %#v", status, body.Error)
	}
	newPassword, _ := body.Data["password"].(string)
	if len(newPassword) < 16 || body.Data["generated"] != true {
		t.Fatalf("重置结果 = %#v; 期望 16 位以上且 generated=true", body.Data)
	}

	// 2. 新密码能登录，旧密码不能（验收标准 7）。
	if status, body := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "erin", "password": newPassword,
	}); status != http.StatusOK {
		t.Fatalf("新密码登录 = %d %#v", status, body.Error)
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "erin", "password": "correct-horse",
	}); status != http.StatusUnauthorized {
		t.Fatalf("旧密码登录 = %d; 期望 401", status)
	}

	// 3. 不能重置自己（验收标准 8）。
	status, body = s.do(http.MethodGet, "/api/v1/admin/users?q=admin", adminToken, nil)
	var selfUID string
	for _, user := range body.Items {
		if user["email"] == testAdminEmail {
			selfUID, _ = user["uid"].(string)
		}
	}
	status, body = s.do(http.MethodPost, "/api/v1/admin/users/"+selfUID+"/reset-password", adminToken, nil)
	if status != http.StatusConflict || body.Error.Code != "ADMIN_CANNOT_RESET_SELF" {
		t.Fatalf("重置自己 = %d %#v", status, body.Error)
	}

	// 4. 指定密码时同样要过策略。
	status, body = s.do(http.MethodPost, "/api/v1/admin/users/"+erinUID+"/reset-password", adminToken, map[string]string{
		"password": "123",
	})
	fields, _ := body.Error.Details["fields"].(map[string]any)
	if status != http.StatusUnprocessableEntity || fields["password"] == nil {
		t.Fatalf("指定弱密码 = %d %#v", status, body.Error)
	}

	// 5. 审计留痕，且不含密码明文。
	status, body = s.do(http.MethodGet, "/api/v1/admin/audit-logs?action=user.reset_password", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("审计列表 = %d %#v", status, body.Error)
	}
	if len(body.Items) == 0 {
		t.Fatalf("应至少有两条重置记录")
	}
	for _, entry := range body.Items {
		detail, _ := entry["detail"].(map[string]any)
		if detail["generated"] == nil {
			t.Fatalf("审计细节应记录 generated: %#v", entry)
		}
		// 审计里绝不能出现密码明文。
		for _, value := range detail {
			if text, ok := value.(string); ok && text == newPassword {
				t.Fatal("审计日志里出现了密码明文")
			}
		}
	}
}

func TestAdminAuditLogFilters(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	// 造两条不同动作的审计：一次建用户、一次改设置。
	if status, body := s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "frank", "email": "frank@example.com", "password": "correct-horse",
	}); status != http.StatusCreated {
		t.Fatalf("创建 frank = %d %#v", status, body.Error)
	}
	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", adminToken, map[string]any{
		"site.name": "审计测试",
	}); status != http.StatusOK {
		t.Fatalf("改设置 = %d %#v", status, body.Error)
	}

	// 全量列表里两种动作都在。
	_, body := s.do(http.MethodGet, "/api/v1/admin/audit-logs", adminToken, nil)
	actions := map[string]bool{}
	for _, entry := range body.Items {
		if action, ok := entry["action"].(string); ok {
			actions[action] = true
		}
	}
	for _, want := range []string{"user.create", "settings.update"} {
		if !actions[want] {
			t.Fatalf("审计缺少动作 %s: %#v", want, actions)
		}
	}

	// 按动作筛选只返回该动作。
	_, body = s.do(http.MethodGet, "/api/v1/admin/audit-logs?action=settings.update", adminToken, nil)
	if len(body.Items) == 0 {
		t.Fatal("按动作筛选返回空")
	}
	for _, entry := range body.Items {
		if entry["action"] != "settings.update" {
			t.Fatalf("筛选结果混入了其它动作: %#v", entry)
		}
	}

	// 不存在的操作人 uid → 空列表而不是 404。
	status, body := s.do(http.MethodGet, "/api/v1/admin/audit-logs?actor_uid=no-such-user", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("未知操作人 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 0 {
		t.Fatalf("未知操作人应返回空列表，实际 %d 条", len(body.Items))
	}
}

func TestAdminStats(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)
	s.registerUser("grace")

	status, body := s.do(http.MethodGet, "/api/v1/admin/stats", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("统计 = %d %#v", status, body.Error)
	}
	// 种子管理员 + grace = 2 个用户。
	if count, _ := body.Data["userCount"].(float64); count < 2 {
		t.Fatalf("userCount = %#v; 期望 >= 2", body.Data["userCount"])
	}
	if _, ok := body.Data["activeUserCount"]; !ok {
		t.Fatalf("统计缺少 activeUserCount: %#v", body.Data)
	}
	// 导图计数在 M2 前固定为 0，但字段必须存在。
	if _, ok := body.Data["mapCount"]; !ok {
		t.Fatalf("统计缺少 mapCount: %#v", body.Data)
	}
}

func TestAdminDeleteUser(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)

	status, body := s.do(http.MethodPost, "/api/v1/admin/users", adminToken, map[string]string{
		"username": "heidi", "email": "heidi@example.com", "password": "correct-horse",
	})
	if status != http.StatusCreated {
		t.Fatalf("创建 heidi = %d %#v", status, body.Error)
	}
	heidiUID, _ := body.Data["uid"].(string)
	heidiToken := s.loginAs("heidi", "correct-horse")

	// 非法的导图策略 → 422。
	status, body = s.do(http.MethodDelete, "/api/v1/admin/users/"+heidiUID+"?map_strategy=burn", adminToken, nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("非法策略 = %d %#v", status, body.Error)
	}

	// 正常删除 → 204。
	status, _ = s.do(http.MethodDelete, "/api/v1/admin/users/"+heidiUID, adminToken, nil)
	if status != http.StatusNoContent {
		t.Fatalf("删除 = %d; 期望 204", status)
	}

	// 删除后：登录失败，已签发令牌失效。
	if status, _ := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "heidi", "password": "correct-horse",
	}); status != http.StatusUnauthorized {
		t.Fatalf("删除后登录 = %d; 期望 401", status)
	}
	if status, _ := s.do(http.MethodGet, "/api/v1/auth/me", heidiToken, nil); status != http.StatusUnauthorized {
		t.Fatalf("删除后 me = %d; 期望 401", status)
	}

	// 再删一次 → 404（软删除后查不到）。
	if status, _ := s.do(http.MethodDelete, "/api/v1/admin/users/"+heidiUID, adminToken, nil); status != http.StatusUnauthorized && status != http.StatusNotFound {
		t.Fatalf("重复删除 = %d; 期望 401/404", status)
	}

	// 删除动作留痕。
	_, body = s.do(http.MethodGet, "/api/v1/admin/audit-logs?action=user.delete", adminToken, nil)
	found := false
	for _, entry := range body.Items {
		if target, _ := entry["targetId"].(string); strings.Contains(target, heidiUID) {
			found = true
		}
	}
	if !found {
		t.Fatalf("审计里找不到删除记录: %#v", body.Data)
	}
}
