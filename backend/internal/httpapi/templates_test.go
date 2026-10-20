package httpapi_test

import (
	"net/http"
	"testing"
)

// 这一组覆盖模板接口的 HTTP 契约：鉴权边界、列表不带文档、单条带文档、
// 另存为模板、改名、删除、站点开关。service 层已经有单测，这里测的是
// 「路由挂对了没有、响应形状对不对、跨用户真的读不到」。

func TestTemplateRoutesRequireAuth(t *testing.T) {
	s := newAuthTestServer(t)

	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/templates"},
		{http.MethodGet, "/api/v1/templates/some-uid"},
		{http.MethodPost, "/api/v1/templates"},
		{http.MethodPatch, "/api/v1/templates/some-uid"},
		{http.MethodDelete, "/api/v1/templates/some-uid"},
	}
	for _, route := range routes {
		status, body := s.do(route.method, route.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Fatalf("%s %s = %d, 期望 401（%#v）", route.method, route.path, status, body.Error)
		}
	}
}

// createTemplate 从导图另存为模板，返回 DTO。
func (s *authTestServer) createTemplate(token, mapUID, name string) map[string]any {
	s.t.Helper()
	status, resp := s.do(http.MethodPost, "/api/v1/templates", token, map[string]any{
		"name": name, "mapUid": mapUID,
	})
	if status != http.StatusCreated {
		s.t.Fatalf("另存为模板 = %d %#v", status, resp.Error)
	}
	return resp.Data
}

func TestTemplateLifecycle(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("tpl_owner")
	mapUID := s.createMap(token, "源导图", "调研", "设计")

	created := s.createTemplate(token, mapUID, "我的起点")
	uid, _ := created["uid"].(string)
	if uid == "" {
		t.Fatalf("另存为模板没有返回 uid: %#v", created)
	}
	if created["name"] != "我的起点" {
		t.Fatalf("name = %v", created["name"])
	}
	// mapDoc 不写 structure，服务端应兜底成 mindmap。
	if created["structure"] != "mindmap" {
		t.Fatalf("structure = %v，期望 mindmap", created["structure"])
	}
	if created["category"] != "user" {
		t.Fatalf("category = %v，期望 user", created["category"])
	}
	if created["isBuiltin"] != false {
		t.Fatalf("isBuiltin = %v，期望 false", created["isBuiltin"])
	}
	document, ok := created["document"].(map[string]any)
	if !ok {
		t.Fatalf("另存为模板应返回文档，得到 %#v", created["document"])
	}
	if document["title"] != "源导图" {
		t.Fatalf("模板文档应原样复制源导图，title = %v", document["title"])
	}

	// ── 列表：有这条，但没有文档 ────────────────────────────────────────
	status, list := s.do(http.MethodGet, "/api/v1/templates", token, nil)
	if status != http.StatusOK {
		t.Fatalf("列表 = %d %#v", status, list.Error)
	}
	if len(list.Items) != 1 {
		t.Fatalf("列表应有 1 条，得到 %d", len(list.Items))
	}
	if _, present := list.Items[0]["document"]; present {
		t.Fatal("列表不应包含 document（一份文档可能到 8 MiB）")
	}
	if list.Items[0]["structure"] != "mindmap" {
		t.Fatalf("列表应带 structure，得到 %v", list.Items[0]["structure"])
	}

	// ── 单条：带文档 ────────────────────────────────────────────────────
	status, detail := s.do(http.MethodGet, "/api/v1/templates/"+uid, token, nil)
	if status != http.StatusOK {
		t.Fatalf("单条读取 = %d %#v", status, detail.Error)
	}
	if _, present := detail.Data["document"]; !present {
		t.Fatal("单条读取必须带 document（用它新建导图）")
	}

	// ── 改名 ────────────────────────────────────────────────────────────
	status, renamed := s.do(http.MethodPatch, "/api/v1/templates/"+uid, token, map[string]string{"name": "改过的名字"})
	if status != http.StatusOK {
		t.Fatalf("改名 = %d %#v", status, renamed.Error)
	}
	if renamed.Data["name"] != "改过的名字" {
		t.Fatalf("改名后 name = %v", renamed.Data["name"])
	}
	if _, present := renamed.Data["document"]; present {
		t.Fatal("改名响应不该带文档")
	}

	// ── 删除 ────────────────────────────────────────────────────────────
	if status, body := s.do(http.MethodDelete, "/api/v1/templates/"+uid, token, nil); status != http.StatusNoContent {
		t.Fatalf("删除 = %d %#v", status, body.Error)
	}
	status, body := s.do(http.MethodGet, "/api/v1/templates/"+uid, token, nil)
	if status != http.StatusNotFound {
		t.Fatalf("删除后再读 = %d %#v，期望 404", status, body.Error)
	}
	if body.Error.Code != "TEMPLATE_NOT_FOUND" {
		t.Fatalf("错误码 = %q，期望 TEMPLATE_NOT_FOUND", body.Error.Code)
	}
}

func TestTemplateCrossUserIsolation(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("tpl_a")
	other := s.registerUser("tpl_b")

	mapUID := s.createMap(owner, "私有源导图", "分支")
	created := s.createTemplate(owner, mapUID, "私有模板")
	uid, _ := created["uid"].(string)

	// 别人的列表里看不到。
	_, list := s.do(http.MethodGet, "/api/v1/templates", other, nil)
	if len(list.Items) != 0 {
		t.Fatalf("他人列表应为空，得到 %d 条", len(list.Items))
	}

	// 读、改、删一律「不存在」，不是「无权限」。
	for _, call := range []struct {
		name   string
		method string
		body   any
	}{
		{"读取", http.MethodGet, nil},
		{"改名", http.MethodPatch, map[string]string{"name": "抢"}},
		{"删除", http.MethodDelete, nil},
	} {
		status, body := s.do(call.method, "/api/v1/templates/"+uid, other, call.body)
		if status != http.StatusNotFound {
			t.Fatalf("%s 他人模板 = %d，期望 404", call.name, status)
		}
		if body.Error.Code != "TEMPLATE_NOT_FOUND" {
			t.Fatalf("%s 错误码 = %q", call.name, body.Error.Code)
		}
	}

	// 拿别人的导图另存为模板：同样是「导图不存在」。
	status, body := s.do(http.MethodPost, "/api/v1/templates", other, map[string]any{
		"name": "偷", "mapUid": mapUID,
	})
	if status != http.StatusNotFound {
		t.Fatalf("拿他人导图另存 = %d，期望 404", status)
	}
	if body.Error.Code != "MAP_NOT_FOUND" {
		t.Fatalf("错误码 = %q，期望 MAP_NOT_FOUND", body.Error.Code)
	}
}

func TestTemplateValidation(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("tpl_valid")
	mapUID := s.createMap(token, "校验源", "分支")

	cases := []struct {
		name  string
		body  map[string]any
		field string
	}{
		{"名字为空", map[string]any{"name": "  ", "mapUid": mapUID}, "name"},
		{"缺 mapUid", map[string]any{"name": "模板"}, "mapUid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := s.do(http.MethodPost, "/api/v1/templates", token, tc.body)
			if status != http.StatusUnprocessableEntity {
				t.Fatalf("%s = %d，期望 422", tc.name, status)
			}
			if body.Error.Code != "VALIDATION_FAILED" {
				t.Fatalf("错误码 = %q", body.Error.Code)
			}
			fields, _ := body.Error.Details["fields"].(map[string]any)
			if fields[tc.field] == nil {
				t.Fatalf("期望字段错误 %q，得到 %#v", tc.field, fields)
			}
		})
	}
}

func TestTemplateDisabledBySiteSwitch(t *testing.T) {
	s := newAuthTestServer(t)
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	token := s.registerUser("tpl_switch")
	mapUID := s.createMap(token, "开关源", "分支")
	created := s.createTemplate(token, mapUID, "关闭前的模板")
	uid, _ := created["uid"].(string)

	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", admin, map[string]any{
		"feature.user_template_enabled": false,
	}); status != http.StatusOK {
		t.Fatalf("关闭用户模板 = %d %#v", status, body.Error)
	}
	t.Cleanup(func() {
		s.do(http.MethodPut, "/api/v1/admin/settings", admin, map[string]any{
			"feature.user_template_enabled": true,
		})
	})

	// 列表、另存、删除全部 403 TEMPLATE_DISABLED。
	for _, call := range []struct {
		name   string
		method string
		path   string
		body   any
	}{
		{"列表", http.MethodGet, "/api/v1/templates", nil},
		{"另存", http.MethodPost, "/api/v1/templates", map[string]any{"name": "x", "mapUid": mapUID}},
		{"删除", http.MethodDelete, "/api/v1/templates/" + uid, nil},
	} {
		status, body := s.do(call.method, call.path, token, call.body)
		if status != http.StatusForbidden {
			t.Fatalf("关闭后%s = %d，期望 403", call.name, status)
		}
		if body.Error.Code != "TEMPLATE_DISABLED" {
			t.Fatalf("关闭后%s 错误码 = %q，期望 TEMPLATE_DISABLED", call.name, body.Error.Code)
		}
	}
}
