package httpapi_test

import (
	"net/http"
	"testing"
)

// 这一组覆盖自定义主题接口的 HTTP 契约：鉴权、CRUD 生命周期、字段错误形状、
// 跨用户隔离。service 层已有单测，这里测的是「路由挂对了没有、DTO 长什么样」——
// 前端「保存为我的主题」完全依赖 themeDTO 的字段形状，形状变了必须在这里红。

// themeConfigBody 造一份最小但合法的 Theme 配置。
//
// 故意带一个内置配色的 id（classic-rainbow）：服务端必须把它改写成新主题
// 自己的 uid，否则一份自定义主题会顶着内置配色的 id 出现在列表里。
func themeConfigBody() map[string]any {
	return map[string]any{
		"id":       "classic-rainbow",
		"name":     "经典彩虹",
		"category": "classic",
		"palette": map[string]any{
			"colors":          []string{"#E32925", "#1878CD"},
			"lineColors":      []string{"#E32925", "#1878CD"},
			"backgroundColor": "#FFFFFF",
		},
		"global": map[string]any{
			"fontFamily": "system", "fontSize": 14, "lineWidth": 2,
			"backgroundColor": "#FFFFFF",
		},
		"centralTopic":  map[string]any{"fill": "#1878CD", "fontSize": 24},
		"mainTopic":     map[string]any{"fill": "#E32925"},
		"subTopic":      map[string]any{},
		"rainbowBranch": true,
		"rainbowColors": []string{"#E32925", "#1878CD"},
		"layout":        map[string]any{"compact": false, "autoBalance": true},
	}
}

func TestThemeRoutesRequireAuth(t *testing.T) {
	s := newAuthTestServer(t)

	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/themes"},
		{http.MethodPost, "/api/v1/themes"},
		{http.MethodPut, "/api/v1/themes/some-uid"},
		{http.MethodDelete, "/api/v1/themes/some-uid"},
	}
	for _, route := range routes {
		status, body := s.do(route.method, route.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Fatalf("%s %s 未登录 = %d; 期望 401（%#v）", route.method, route.path, status, body.Error)
		}
	}
}

func TestThemeCRUDLifecycle(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("themer")

	// 1. 初始列表为空。空列表必须是 []，不是 null——前端直接 .map 会炸。
	status, body := s.do(http.MethodGet, "/api/v1/themes", token, nil)
	if status != http.StatusOK {
		t.Fatalf("列表 = %d %#v", status, body.Error)
	}
	if body.Items == nil || len(body.Items) != 0 {
		t.Fatalf("初始列表期望空数组，实际 %#v", body.Items)
	}
	if body.Pagination == nil {
		t.Fatal("列表响应必须带 pagination 信封")
	}

	// 2. 创建。
	status, body = s.do(http.MethodPost, "/api/v1/themes", token, map[string]any{
		"name": "我的配色", "config": themeConfigBody(),
	})
	if status != http.StatusCreated {
		t.Fatalf("创建 = %d %#v", status, body.Error)
	}
	uid, _ := body.Data["uid"].(string)
	if uid == "" {
		t.Fatalf("创建没有返回 uid: %#v", body.Data)
	}
	if body.Data["name"] != "我的配色" || body.Data["category"] != "custom" {
		t.Fatalf("DTO 字段不对: %#v", body.Data)
	}
	config, _ := body.Data["config"].(map[string]any)
	if config["id"] != uid {
		t.Errorf("config.id = %v，期望被改写成本主题的 uid %q", config["id"], uid)
	}
	if config["category"] != "custom" {
		t.Errorf("config.category = %v，期望 custom", config["category"])
	}
	// 角色样式要原样透传：服务端不认识的字段也不能被吃掉。
	if _, ok := config["centralTopic"]; !ok {
		t.Errorf("config.centralTopic 被丢掉了: %#v", config)
	}

	// 3. 列表里有它。
	status, body = s.do(http.MethodGet, "/api/v1/themes", token, nil)
	if status != http.StatusOK || len(body.Items) != 1 {
		t.Fatalf("列表 = %d，%d 条", status, len(body.Items))
	}
	if body.Items[0]["uid"] != uid {
		t.Fatalf("列表里的 uid = %v", body.Items[0]["uid"])
	}

	// 4. 更新：改名 + 换色。
	next := themeConfigBody()
	next["palette"] = map[string]any{
		"colors": []string{"#00FF00"}, "lineColors": []string{"#00FF00"}, "backgroundColor": "#000000",
	}
	status, body = s.do(http.MethodPut, "/api/v1/themes/"+uid, token, map[string]any{
		"name": "改名后", "config": next,
	})
	if status != http.StatusOK {
		t.Fatalf("更新 = %d %#v", status, body.Error)
	}
	if body.Data["name"] != "改名后" {
		t.Fatalf("更新后 name = %v", body.Data["name"])
	}
	updatedConfig, _ := body.Data["config"].(map[string]any)
	if updatedConfig["name"] != "改名后" {
		t.Errorf("config.name = %v，期望跟着改", updatedConfig["name"])
	}

	// 5. 删除 → 204，列表回到空。
	if status, body := s.do(http.MethodDelete, "/api/v1/themes/"+uid, token, nil); status != http.StatusNoContent {
		t.Fatalf("删除 = %d %#v", status, body.Error)
	}
	status, body = s.do(http.MethodGet, "/api/v1/themes", token, nil)
	if status != http.StatusOK || len(body.Items) != 0 {
		t.Fatalf("删除后列表 = %d，%d 条", status, len(body.Items))
	}

	// 6. 再删一次 → THEME_NOT_FOUND，而不是 500。
	status, body = s.do(http.MethodDelete, "/api/v1/themes/"+uid, token, nil)
	if status != http.StatusNotFound || body.Error.Code != "THEME_NOT_FOUND" {
		t.Fatalf("重复删除 = %d %#v", status, body.Error)
	}
}

func TestThemeValidationReturnsFieldErrors(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("careless")

	// 缺 config：handler 层就该拦下，不进 service。
	status, body := s.do(http.MethodPost, "/api/v1/themes", token, map[string]any{"name": "空的"})
	if status != http.StatusUnprocessableEntity || body.Error.Code != "VALIDATION_FAILED" {
		t.Fatalf("缺 config = %d %#v", status, body.Error)
	}
	if fields, _ := body.Error.Details["fields"].(map[string]any); fields["config"] == nil {
		t.Fatalf("缺少 fields.config: %#v", body.Error.Details)
	}

	// 颜色不是 #RRGGBB：service 层拦下，字段错误同样落在 config 上，
	// 前端才能把红字标在配置区域而不是整个表单。
	bad := themeConfigBody()
	bad["palette"] = map[string]any{"colors": []string{"red"}}
	status, body = s.do(http.MethodPost, "/api/v1/themes", token, map[string]any{
		"name": "坏颜色", "config": bad,
	})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("坏颜色 = %d %#v", status, body.Error)
	}
	if fields, _ := body.Error.Details["fields"].(map[string]any); fields["config"] == nil {
		t.Fatalf("缺少 fields.config: %#v", body.Error.Details)
	}

	// 空名字。
	status, body = s.do(http.MethodPost, "/api/v1/themes", token, map[string]any{
		"name": "   ", "config": themeConfigBody(),
	})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("空名字 = %d %#v", status, body.Error)
	}
	if fields, _ := body.Error.Details["fields"].(map[string]any); fields["name"] == nil {
		t.Fatalf("缺少 fields.name: %#v", body.Error.Details)
	}
}

func TestThemesAreIsolatedBetweenUsers(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("owner")
	other := s.registerUser("intruder")

	status, body := s.do(http.MethodPost, "/api/v1/themes", owner, map[string]any{
		"name": "只属于我", "config": themeConfigBody(),
	})
	if status != http.StatusCreated {
		t.Fatalf("创建 = %d %#v", status, body.Error)
	}
	uid, _ := body.Data["uid"].(string)

	// 别人的列表里看不到。
	if _, body := s.do(http.MethodGet, "/api/v1/themes", other, nil); len(body.Items) != 0 {
		t.Fatalf("别人的列表里出现了 %d 条主题", len(body.Items))
	}
	// 改/删一律 404（不是 403：403 会泄露「这个 uid 存在」）。
	status, body = s.do(http.MethodPut, "/api/v1/themes/"+uid, other, map[string]any{
		"name": "偷改", "config": themeConfigBody(),
	})
	if status != http.StatusNotFound || body.Error.Code != "THEME_NOT_FOUND" {
		t.Fatalf("跨用户更新 = %d %#v", status, body.Error)
	}
	status, body = s.do(http.MethodDelete, "/api/v1/themes/"+uid, other, nil)
	if status != http.StatusNotFound || body.Error.Code != "THEME_NOT_FOUND" {
		t.Fatalf("跨用户删除 = %d %#v", status, body.Error)
	}
}
