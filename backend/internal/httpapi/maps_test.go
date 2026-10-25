package httpapi_test

import (
	"fmt"
	"net/http"
	"testing"
)

// 这一组覆盖导图接口的 HTTP 契约：鉴权、版本号、跨用户隔离、回收站。
// service 层已经有单测，这里测的是「路由挂对了没有、DTO 长什么样」——
// 前端的自动保存完全依赖 saveResultDTO 的字段形状，形状变了必须在这里红。

// mapDoc 造一份最小但合法的 .wmind 文档。
//
// branches 里每一项是一个子主题，所以节点数 = 1 + len(branches)。
func mapDoc(title string, branches ...string) map[string]any {
	attached := make([]any, 0, len(branches))
	for i, branch := range branches {
		attached = append(attached, map[string]any{
			"id":    fmt.Sprintf("topic-%d", i+1),
			"title": branch,
		})
	}
	return map[string]any{
		"format":        "wmind",
		"formatVersion": "1.0",
		"id":            "doc-1",
		"title":         title,
		"sheets": []any{map[string]any{
			"id": "sheet-1",
			"rootTopic": map[string]any{
				"id":    "root",
				"title": title,
				"children": map[string]any{
					"attached": attached,
				},
			},
		}},
	}
}

// createMap 新建一张导图并返回 uid。
func (s *authTestServer) createMap(token, title string, branches ...string) string {
	s.t.Helper()
	status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"title": title, "document": mapDoc(title, branches...),
	})
	if status != http.StatusCreated {
		s.t.Fatalf("创建导图 %q = %d %#v", title, status, body.Error)
	}
	uid, _ := body.Data["uid"].(string)
	if uid == "" {
		s.t.Fatalf("创建导图 %q 没有返回 uid", title)
	}
	return uid
}

func TestMapRoutesRequireAuth(t *testing.T) {
	s := newAuthTestServer(t)

	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/maps"},
		{http.MethodPost, "/api/v1/maps"},
		{http.MethodGet, "/api/v1/maps/some-uid"},
		{http.MethodPut, "/api/v1/maps/some-uid"},
		{http.MethodPatch, "/api/v1/maps/some-uid"},
		{http.MethodPut, "/api/v1/maps/some-uid/thumbnail"},
		{http.MethodDelete, "/api/v1/maps/some-uid"},
		{http.MethodPost, "/api/v1/maps/some-uid/duplicate"},
		{http.MethodGet, "/api/v1/trash"},
		{http.MethodDelete, "/api/v1/trash"},
		{http.MethodPost, "/api/v1/trash/some-uid/restore"},
		{http.MethodDelete, "/api/v1/trash/some-uid"},
	}
	for _, route := range routes {
		status, body := s.do(route.method, route.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Fatalf("%s %s 未登录 = %d; 期望 401（%#v）", route.method, route.path, status, body.Error)
		}
	}
}

func TestMapCreateGetSaveRoundTrip(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")

	// 1. 创建：201、版本号从 1 开始、节点数由服务端数出来（不信客户端）。
	status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"title": "  产品规划  ", "document": mapDoc("产品规划", "调研", "设计"),
	})
	if status != http.StatusCreated {
		t.Fatalf("创建 = %d %#v", status, body.Error)
	}
	uid, _ := body.Data["uid"].(string)
	if uid == "" {
		t.Fatalf("创建没有返回 uid: %#v", body.Data)
	}
	if body.Data["title"] != "产品规划" {
		t.Fatalf("标题应去掉首尾空白，实际 %#v", body.Data["title"])
	}
	if version, _ := body.Data["version"].(float64); version != 1 {
		t.Fatalf("新建版本号 = %#v; 期望 1", body.Data["version"])
	}
	if count, _ := body.Data["nodeCount"].(float64); count != 3 {
		t.Fatalf("节点数 = %#v; 期望 3（中心主题 + 2 个子主题）", body.Data["nodeCount"])
	}
	if doc, _ := body.Data["document"].(map[string]any); doc["format"] != "wmind" {
		t.Fatalf("详情应回完整文档: %#v", body.Data["document"])
	}

	// 2. 读取。
	status, body = s.do(http.MethodGet, "/api/v1/maps/"+uid, token, nil)
	if status != http.StatusOK {
		t.Fatalf("读取 = %d %#v", status, body.Error)
	}
	if doc, _ := body.Data["document"].(map[string]any); doc["id"] != "doc-1" {
		t.Fatalf("读到的文档不对: %#v", body.Data["document"])
	}

	// 3. 保存：版本号 1 → 2，响应只回版本与计数，不回整份文档。
	status, body = s.do(http.MethodPut, "/api/v1/maps/"+uid, token, map[string]any{
		"version": 1, "title": "产品规划 v2",
		"document": mapDoc("产品规划 v2", "调研", "设计", "开发"),
	})
	if status != http.StatusOK {
		t.Fatalf("保存 = %d %#v", status, body.Error)
	}
	if version, _ := body.Data["version"].(float64); version != 2 {
		t.Fatalf("保存后版本号 = %#v; 期望 2", body.Data["version"])
	}
	if count, _ := body.Data["nodeCount"].(float64); count != 4 {
		t.Fatalf("保存后节点数 = %#v; 期望 4", body.Data["nodeCount"])
	}
	if _, exists := body.Data["document"]; exists {
		t.Fatalf("保存响应不该回文档，自动保存每几秒一次，回传 1 MB 纯属浪费")
	}

	// 4. 再读：标题与内容都落盘了。
	status, body = s.do(http.MethodGet, "/api/v1/maps/"+uid, token, nil)
	if status != http.StatusOK {
		t.Fatalf("保存后读取 = %d %#v", status, body.Error)
	}
	if body.Data["title"] != "产品规划 v2" {
		t.Fatalf("标题没更新: %#v", body.Data["title"])
	}
	if version, _ := body.Data["version"].(float64); version != 2 {
		t.Fatalf("读到的版本号 = %#v; 期望 2", body.Data["version"])
	}
}

func TestMapSaveRequiresVersion(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	uid := s.createMap(token, "无版本号")

	status, body := s.do(http.MethodPut, "/api/v1/maps/"+uid, token, map[string]any{
		"document": mapDoc("无版本号"),
	})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("缺版本号 = %d; 期望 422（%#v）", status, body.Error)
	}
	if body.Error == nil || body.Error.Code != "VALIDATION_FAILED" {
		t.Fatalf("缺版本号的错误码 = %#v", body.Error)
	}
	fields, _ := body.Error.Details["fields"].(map[string]any)
	if fields["version"] == nil {
		t.Fatalf("应指出 version 字段有问题: %#v", body.Error.Details)
	}
}

func TestMapSaveConflictReportsCurrentVersion(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	uid := s.createMap(token, "并发冲突")

	// 第一次保存成功，服务器版本变成 2。
	status, body := s.do(http.MethodPut, "/api/v1/maps/"+uid, token, map[string]any{
		"version": 1, "title": "并发冲突", "document": mapDoc("并发冲突", "A"),
	})
	if status != http.StatusOK {
		t.Fatalf("首次保存 = %d %#v", status, body.Error)
	}

	// 第二个客户端还拿着版本 1 → 409，并且必须告诉它服务器现在是几。
	status, body = s.do(http.MethodPut, "/api/v1/maps/"+uid, token, map[string]any{
		"version": 1, "title": "并发冲突", "document": mapDoc("并发冲突", "B"),
	})
	if status != http.StatusConflict {
		t.Fatalf("陈旧版本保存 = %d; 期望 409（%#v）", status, body.Error)
	}
	if body.Error == nil || body.Error.Code != "MAP_VERSION_CONFLICT" {
		t.Fatalf("冲突错误码 = %#v", body.Error)
	}
	// 只回「冲突了」是不够的：前端要知道差多少才能决定覆盖还是另存。
	if current, _ := body.Error.Details["currentVersion"].(float64); current != 2 {
		t.Fatalf("details.currentVersion = %#v; 期望 2", body.Error.Details["currentVersion"])
	}
	if _, ok := body.Error.Details["currentUpdatedAt"].(string); !ok {
		t.Fatalf("details 应带 currentUpdatedAt: %#v", body.Error.Details)
	}

	// 冲突不能把服务端的内容冲掉。
	status, body = s.do(http.MethodGet, "/api/v1/maps/"+uid, token, nil)
	if status != http.StatusOK {
		t.Fatalf("冲突后读取 = %d %#v", status, body.Error)
	}
	doc, _ := body.Data["document"].(map[string]any)
	root, _ := doc["sheets"].([]any)[0].(map[string]any)["rootTopic"].(map[string]any)
	attached, _ := root["children"].(map[string]any)["attached"].([]any)
	if len(attached) != 1 || attached[0].(map[string]any)["title"] != "A" {
		t.Fatalf("冲突后文档应保持第一次保存的内容，实际 %#v", attached)
	}
}

func TestMapRejectsInvalidDocument(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")

	cases := []struct {
		name     string
		document any
		reason   string
	}{
		{"不是对象", "这不是文档", "文档不是合法的 JSON"},
		{"格式不对", map[string]any{
			"format": "drawio",
			"sheets": []any{map[string]any{"rootTopic": map[string]any{"id": "r", "title": "x"}}},
		}, "format 必须是 wmind"},
		{"没有画布", map[string]any{
			"format": "wmind", "sheets": []any{},
		}, "文档至少需要一张画布"},
		{"没有中心主题", map[string]any{
			"format": "wmind", "sheets": []any{map[string]any{}},
		}, "文档没有中心主题"},
	}
	for _, tc := range cases {
		status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
			"title": tc.name, "document": tc.document,
		})
		if status != http.StatusUnprocessableEntity {
			t.Fatalf("%s: 状态 = %d; 期望 422（%#v）", tc.name, status, body.Error)
		}
		if body.Error == nil || body.Error.Code != "DOCUMENT_INVALID" {
			t.Fatalf("%s: 错误码 = %#v", tc.name, body.Error)
		}
		if body.Error.Details["reason"] != tc.reason {
			t.Fatalf("%s: reason = %#v; 期望 %q", tc.name, body.Error.Details["reason"], tc.reason)
		}
	}

	// 缺 document 字段同样是 422，而不是 500。
	status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{"title": "空"})
	if status != http.StatusUnprocessableEntity || body.Error.Code != "DOCUMENT_INVALID" {
		t.Fatalf("缺 document = %d %#v", status, body.Error)
	}

	// 一张都没建出来。
	status, body = s.do(http.MethodGet, "/api/v1/maps", token, nil)
	if status != http.StatusOK {
		t.Fatalf("列表 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 0 {
		t.Fatalf("非法文档不该留下任何记录，实际 %d 条", len(body.Items))
	}
}

func TestMapIsolationBetweenUsers(t *testing.T) {
	s := newAuthTestServer(t)
	alice := s.registerUser("alice")
	bob := s.registerUser("bob")
	uid := s.createMap(alice, "alice 的私有导图")

	// 跨用户访问一律 404 而不是 403：告诉对方「这张图存在但不属于你」
	// 本身就是信息泄露。
	attempts := []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/v1/maps/" + uid, nil},
		{http.MethodPut, "/api/v1/maps/" + uid, map[string]any{"version": 1, "document": mapDoc("偷改", "x")}},
		{http.MethodPatch, "/api/v1/maps/" + uid, map[string]any{"title": "偷改名"}},
		{http.MethodDelete, "/api/v1/maps/" + uid, nil},
		{http.MethodPost, "/api/v1/maps/" + uid + "/duplicate", nil},
	}
	for _, attempt := range attempts {
		status, body := s.do(attempt.method, attempt.path, bob, attempt.body)
		if status != http.StatusNotFound {
			t.Fatalf("bob %s %s = %d; 期望 404（%#v）", attempt.method, attempt.path, status, body.Error)
		}
		if body.Error == nil || body.Error.Code != "MAP_NOT_FOUND" {
			t.Fatalf("bob %s 的错误码 = %#v", attempt.method, body.Error)
		}
	}

	// bob 的列表里看不到 alice 的图。
	status, body := s.do(http.MethodGet, "/api/v1/maps", bob, nil)
	if status != http.StatusOK {
		t.Fatalf("bob 列表 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 0 {
		t.Fatalf("bob 不该看到别人的导图，实际 %d 条", len(body.Items))
	}

	// alice 自己还是好的。
	if status, body := s.do(http.MethodGet, "/api/v1/maps/"+uid, alice, nil); status != http.StatusOK {
		t.Fatalf("alice 读取自己的图 = %d %#v", status, body.Error)
	}
}

func TestMapListSearchRenameAndDuplicate(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	first := s.createMap(token, "产品规划", "调研")
	s.createMap(token, "技术方案")

	// 1. 列表：分页信封 + 不含 document。
	status, body := s.do(http.MethodGet, "/api/v1/maps", token, nil)
	if status != http.StatusOK {
		t.Fatalf("列表 = %d %#v", status, body.Error)
	}
	if body.Pagination == nil || body.Pagination.Total != 2 {
		t.Fatalf("分页总数 = %#v; 期望 2", body.Pagination)
	}
	if len(body.Items) != 2 {
		t.Fatalf("列表条数 = %d; 期望 2", len(body.Items))
	}
	for _, item := range body.Items {
		if _, exists := item["document"]; exists {
			t.Fatalf("列表项不该带 document（一页 20 张图就是 20 MB）: %#v", item)
		}
		if item["uid"] == "" || item["title"] == "" {
			t.Fatalf("列表项缺少基本字段: %#v", item)
		}
	}

	// 2. 搜索：命中一个。
	status, body = s.do(http.MethodGet, "/api/v1/maps?q=产品", token, nil)
	if status != http.StatusOK {
		t.Fatalf("搜索 = %d %#v", status, body.Error)
	}
	if body.Pagination == nil || body.Pagination.Total != 1 || len(body.Items) != 1 {
		t.Fatalf("搜索「产品」命中 = %#v / %d 条", body.Pagination, len(body.Items))
	}

	// 3. 搜索的通配符要被转义：搜 % 不该匹配到全部。
	status, body = s.do(http.MethodGet, "/api/v1/maps?q=%25", token, nil)
	if status != http.StatusOK {
		t.Fatalf("搜索 %% = %d %#v", status, body.Error)
	}
	if len(body.Items) != 0 {
		t.Fatalf("搜 %% 应无命中（LIKE 通配符要转义），实际 %d 条", len(body.Items))
	}

	// 4. 重命名：不动 document，版本号也不变（它不是内容修改）。
	status, body = s.do(http.MethodPatch, "/api/v1/maps/"+first, token, map[string]any{"title": "产品规划 2026"})
	if status != http.StatusOK {
		t.Fatalf("重命名 = %d %#v", status, body.Error)
	}
	if body.Data["title"] != "产品规划 2026" {
		t.Fatalf("重命名后标题 = %#v", body.Data["title"])
	}
	if version, _ := body.Data["version"].(float64); version != 1 {
		t.Fatalf("重命名不该改版本号，实际 %#v", body.Data["version"])
	}

	// 5. 复制：新 uid、版本号 1、标题加后缀、内容一致。
	status, body = s.do(http.MethodPost, "/api/v1/maps/"+first+"/duplicate", token, nil)
	if status != http.StatusCreated {
		t.Fatalf("复制 = %d %#v", status, body.Error)
	}
	copiedUID, _ := body.Data["uid"].(string)
	if copiedUID == "" || copiedUID == first {
		t.Fatalf("副本 uid = %#v; 应该是新的", body.Data["uid"])
	}
	if body.Data["title"] != "产品规划 2026 - 副本" {
		t.Fatalf("副本标题 = %#v", body.Data["title"])
	}
	if version, _ := body.Data["version"].(float64); version != 1 {
		t.Fatalf("副本版本号 = %#v; 期望 1", body.Data["version"])
	}
	if count, _ := body.Data["nodeCount"].(float64); count != 2 {
		t.Fatalf("副本节点数 = %#v; 期望 2", body.Data["nodeCount"])
	}

	// 6. 复制之后列表里有三张。
	status, body = s.do(http.MethodGet, "/api/v1/maps", token, nil)
	if status != http.StatusOK || body.Pagination.Total != 3 {
		t.Fatalf("复制后列表总数 = %#v; 期望 3", body.Pagination)
	}
}

func TestMapTrashLifecycle(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	keep := s.createMap(token, "留下的")
	drop := s.createMap(token, "要删的")

	// 1. 软删除：204，列表里没了，回收站里在。
	if status, _ := s.do(http.MethodDelete, "/api/v1/maps/"+drop, token, nil); status != http.StatusNoContent {
		t.Fatalf("删除 = %d; 期望 204", status)
	}
	status, body := s.do(http.MethodGet, "/api/v1/maps", token, nil)
	if status != http.StatusOK || body.Pagination.Total != 1 {
		t.Fatalf("删除后列表 = %#v; 期望只剩 1 张", body.Pagination)
	}
	status, body = s.do(http.MethodGet, "/api/v1/trash", token, nil)
	if status != http.StatusOK {
		t.Fatalf("回收站 = %d %#v", status, body.Error)
	}
	if body.Pagination == nil || body.Pagination.Total != 1 || len(body.Items) != 1 {
		t.Fatalf("回收站应有一条: %#v / %d", body.Pagination, len(body.Items))
	}
	if body.Items[0]["deleted"] != true {
		t.Fatalf("回收站条目的 deleted 应为 true: %#v", body.Items[0])
	}
	// 已删除的图不能再被读取。
	if status, body := s.do(http.MethodGet, "/api/v1/maps/"+drop, token, nil); status != http.StatusNotFound {
		t.Fatalf("读回收站里的图 = %d; 期望 404（%#v）", status, body.Error)
	}

	// 2. 恢复：回到列表，deleted=false。
	status, body = s.do(http.MethodPost, "/api/v1/trash/"+drop+"/restore", token, nil)
	if status != http.StatusOK {
		t.Fatalf("恢复 = %d %#v", status, body.Error)
	}
	if body.Data["deleted"] != false || body.Data["uid"] != drop {
		t.Fatalf("恢复结果 = %#v", body.Data)
	}
	status, body = s.do(http.MethodGet, "/api/v1/maps", token, nil)
	if status != http.StatusOK || body.Pagination.Total != 2 {
		t.Fatalf("恢复后列表 = %#v; 期望 2 张", body.Pagination)
	}

	// 3. 再次删除后彻底清除：列表与回收站都归零，且无法再恢复。
	if status, _ := s.do(http.MethodDelete, "/api/v1/maps/"+drop, token, nil); status != http.StatusNoContent {
		t.Fatalf("二次删除 = %d", status)
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/trash/"+drop, token, nil); status != http.StatusNoContent {
		t.Fatalf("彻底删除 = %d", status)
	}
	status, body = s.do(http.MethodGet, "/api/v1/trash", token, nil)
	if status != http.StatusOK || body.Pagination.Total != 0 {
		t.Fatalf("彻底删除后回收站 = %#v", body.Pagination)
	}
	if status, body := s.do(http.MethodPost, "/api/v1/trash/"+drop+"/restore", token, nil); status != http.StatusNotFound {
		t.Fatalf("恢复已彻底删除的图 = %d; 期望 404（%#v）", status, body.Error)
	}

	// 4. 清空回收站只影响回收站里的东西。
	if status, _ := s.do(http.MethodDelete, "/api/v1/maps/"+keep, token, nil); status != http.StatusNoContent {
		t.Fatalf("删第二张 = %d", status)
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/trash", token, nil); status != http.StatusNoContent {
		t.Fatalf("清空回收站 = %d", status)
	}
	status, body = s.do(http.MethodGet, "/api/v1/trash", token, nil)
	if status != http.StatusOK || body.Pagination.Total != 0 {
		t.Fatalf("清空后回收站 = %#v", body.Pagination)
	}
	status, body = s.do(http.MethodGet, "/api/v1/maps", token, nil)
	if status != http.StatusOK || body.Pagination.Total != 0 {
		t.Fatalf("清空回收站后主列表 = %#v", body.Pagination)
	}
}

func TestMapEmptyTitleGetsDefault(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")

	// 标题留空不能建出一张「无名」图——列表里会变成一条认不出的记录。
	status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"document": mapDoc(""),
	})
	if status != http.StatusCreated {
		t.Fatalf("空标题创建 = %d %#v", status, body.Error)
	}
	if title, _ := body.Data["title"].(string); title == "" {
		t.Fatalf("空标题应被填上默认值，实际 %#v", body.Data["title"])
	}
}

func TestMapUnknownUIDReturnsNotFound(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")

	// 不存在的 uid 与别人的 uid 表现必须一致，否则可以拿它探测哪些 uid 存在。
	status, body := s.do(http.MethodGet, "/api/v1/maps/does-not-exist", token, nil)
	if status != http.StatusNotFound || body.Error.Code != "MAP_NOT_FOUND" {
		t.Fatalf("未知 uid = %d %#v", status, body.Error)
	}
	// 保存一个不存在的图也是 404，而不是 409——版本冲突在这里毫无意义。
	status, body = s.do(http.MethodPut, "/api/v1/maps/does-not-exist", token, map[string]any{
		"version": 1, "document": mapDoc("幽灵"),
	})
	if status != http.StatusNotFound || body.Error.Code != "MAP_NOT_FOUND" {
		t.Fatalf("保存未知 uid = %d %#v", status, body.Error)
	}
}

func TestMapListSort(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")

	// 创建顺序与标题顺序刻意相反：只按 updated_at 排的实现会让 title 断言红。
	s.createMap(token, "banana")
	s.createMap(token, "apple")

	titles := func(query string) []string {
		t.Helper()
		status, body := s.do(http.MethodGet, "/api/v1/maps"+query, token, nil)
		if status != http.StatusOK {
			t.Fatalf("列表 %q = %d %#v", query, status, body.Error)
		}
		out := make([]string, 0, len(body.Items))
		for _, row := range body.Items {
			title, _ := row["title"].(string)
			out = append(out, title)
		}
		return out
	}

	if got := titles("?sort=title"); len(got) != 2 || got[0] != "apple" || got[1] != "banana" {
		t.Fatalf("sort=title = %v; 期望 [apple banana]", got)
	}
	// 未知取值回落到默认排序，而不是 422：排序是展示偏好，不值得让整页失败。
	if got := titles("?sort=nonsense"); len(got) != 2 || got[0] != "apple" {
		t.Fatalf("未知 sort 应回落到最近修改 = %v", got)
	}
}

func TestMapThumbnailRoundTrip(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	uid := s.createMap(token, "产品规划", "调研")

	// 只接受站内相对路径：这个字段会被所有列表页渲染进 <img src>。
	for _, bad := range []string{"https://evil.example/x.png", "//evil.example/x.png", "javascript:alert(1)"} {
		status, body := s.do(http.MethodPut, "/api/v1/maps/"+uid+"/thumbnail", token, map[string]any{
			"thumbnailUrl": bad,
		})
		fields, _ := body.Error.Details["fields"].(map[string]any)
		if status != http.StatusUnprocessableEntity || fields["thumbnailUrl"] == nil {
			t.Fatalf("缩略图 %q = %d %#v; 期望 422 + fields.thumbnailUrl", bad, status, body.Error)
		}
	}

	uploadStatus, uploaded := s.uploadFile(token, "file", "thumb.png", "image/png", pngBytes(t, 4, 4))
	if uploadStatus != http.StatusOK {
		t.Fatalf("upload thumbnail = %d", uploadStatus)
	}
	thumbnail := uploaded.Data["url"].(string)
	status, body := s.do(http.MethodPut, "/api/v1/maps/"+uid+"/thumbnail", token, map[string]any{
		"thumbnailUrl": thumbnail,
	})
	if status != http.StatusNoContent {
		t.Fatalf("设置缩略图 = %d %#v", status, body.Error)
	}

	// 自动保存不带缩略图。保存之后缩略图必须还在——它曾经在这里被擦成空串。
	status, body = s.do(http.MethodPut, "/api/v1/maps/"+uid, token, map[string]any{
		"version": 1, "title": "产品规划", "document": mapDoc("产品规划", "调研", "设计"),
	})
	if status != http.StatusOK {
		t.Fatalf("保存 = %d %#v", status, body.Error)
	}
	status, body = s.do(http.MethodGet, "/api/v1/maps/"+uid, token, nil)
	if status != http.StatusOK {
		t.Fatalf("读取 = %d %#v", status, body.Error)
	}
	if got, _ := body.Data["thumbnailUrl"].(string); got != thumbnail {
		t.Fatalf("保存后缩略图 = %q; 期望原样保留", got)
	}

	// 空串是合法的：表示清除。
	status, _ = s.do(http.MethodPut, "/api/v1/maps/"+uid+"/thumbnail", token, map[string]any{"thumbnailUrl": ""})
	if status != http.StatusNoContent {
		t.Fatalf("清除缩略图 = %d", status)
	}
	_, body = s.do(http.MethodGet, "/api/v1/maps/"+uid, token, nil)
	if got, _ := body.Data["thumbnailUrl"].(string); got != "" {
		t.Fatalf("清除后缩略图 = %q; 期望空串", got)
	}
}
