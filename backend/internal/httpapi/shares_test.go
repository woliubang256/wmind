package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// 这一组覆盖分享接口的 HTTP 契约：鉴权边界、令牌的四种失效形态、
// 密码流程、服务端剥离备注、站点开关。service 层已经有单测，这里测的是
// 「路由挂对了没有、公开接口真的不用登录、响应里真的没有敏感字段」。

// doHeader 与 do 相同，但可以额外带请求头（X-Share-Access 需要）。
func (s *authTestServer) doHeader(method, path, token string, body any, headers map[string]string) (int, apiResponse) {
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
	for key, value := range headers {
		req.Header.Set(key, value)
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

// createShare 建一条分享链接并返回它的 DTO。
func (s *authTestServer) createShare(token, mapUID string, body map[string]any) map[string]any {
	s.t.Helper()
	status, resp := s.do(http.MethodPost, "/api/v1/maps/"+mapUID+"/shares", token, body)
	if status != http.StatusCreated {
		s.t.Fatalf("创建分享 = %d %#v", status, resp.Error)
	}
	return resp.Data
}

// mapDocWithNotes 造一份带备注的文档，用来验证服务端剥离。
func mapDocWithNotes(title, note string) map[string]any {
	doc := mapDoc(title, "调研")
	sheets := doc["sheets"].([]any)
	sheet := sheets[0].(map[string]any)
	root := sheet["rootTopic"].(map[string]any)
	root["notes"] = map[string]any{"plain": note, "html": "<p>" + note + "</p>"}
	root["extensions"] = []any{map[string]any{"internal": "do-not-leak"}}
	doc["extensions"] = []any{map[string]any{"internal": "top-level-secret"}}
	doc["meta"] = map[string]any{"app": "wmind/9.9.9", "createdAt": "2026-10-21T10:00:00Z"}
	return doc
}

func TestShareRoutesRequireAuth(t *testing.T) {
	s := newAuthTestServer(t)

	ownerRoutes := []struct{ method, path string }{
		{http.MethodPost, "/api/v1/maps/some-uid/shares"},
		{http.MethodGet, "/api/v1/maps/some-uid/shares"},
		{http.MethodGet, "/api/v1/shares"},
		{http.MethodPatch, "/api/v1/shares/some-uid"},
		{http.MethodDelete, "/api/v1/shares/some-uid"},
	}
	for _, route := range ownerRoutes {
		status, body := s.do(route.method, route.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Fatalf("%s %s 未登录 = %d; 期望 401（%#v）", route.method, route.path, status, body.Error)
		}
	}

	// 公开接口**不能**要求登录：分享页的访客通常没有账号。这里断言它们
	// 返回的不是 401——不存在的令牌应当是 404。
	publicRoutes := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/public/shares/no-such-token"},
		{http.MethodPost, "/api/v1/public/shares/no-such-token/verify"},
	}
	for _, route := range publicRoutes {
		status, body := s.do(route.method, route.path, "", map[string]any{"password": "x"})
		if status == http.StatusUnauthorized {
			t.Fatalf("%s %s 未登录 = 401，公开接口不该要求登录（%#v）", route.method, route.path, body.Error)
		}
		if status != http.StatusNotFound || body.Error == nil || body.Error.Code != "SHARE_NOT_FOUND" {
			t.Fatalf("%s %s = %d %#v，期望 404 SHARE_NOT_FOUND", route.method, route.path, status, body.Error)
		}
	}
}

func TestShareCreateAndPublicRead(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	mapUID := s.createMap(token, "产品规划", "调研", "设计")

	share := s.createShare(token, mapUID, map[string]any{})
	if share["token"] == "" || share["token"] == nil {
		t.Fatalf("没有返回 token: %#v", share)
	}
	if share["hasPassword"] != false {
		t.Fatalf("hasPassword = %#v，期望 false", share["hasPassword"])
	}
	if share["allowDownload"] != true || share["showNotes"] != true {
		t.Fatalf("两个开关默认应为 true: %#v", share)
	}
	// 站点没配 site.base_url，URL 退化为站内相对路径。
	shareToken := share["token"].(string)
	if want := "/s/" + shareToken; share["url"] != want {
		t.Fatalf("url = %#v，期望 %q", share["url"], want)
	}

	// 匿名读取：200，带文档与站点信息。
	status, body := s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("公开读取 = %d %#v", status, body.Error)
	}
	if body.Data["title"] != "产品规划" {
		t.Fatalf("title = %#v", body.Data["title"])
	}
	if body.Data["siteName"] != "wmind" {
		t.Fatalf("siteName = %#v", body.Data["siteName"])
	}
	if body.Data["ownerNickname"] != "alice" {
		t.Fatalf("ownerNickname = %#v", body.Data["ownerNickname"])
	}
	document, _ := body.Data["document"].(map[string]any)
	if document == nil || document["format"] != "wmind" {
		t.Fatalf("document 不对: %#v", body.Data["document"])
	}

	// 公开响应里不能出现属主标识：只有昵称。
	for _, forbidden := range []string{"uid", "email", "ownerUid", "ownerEmail"} {
		if _, exists := body.Data[forbidden]; exists {
			t.Fatalf("公开响应里不应有 %q: %#v", forbidden, body.Data)
		}
	}
}

func TestSharePasswordFlow(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	mapUID := s.createMap(token, "产品规划")

	share := s.createShare(token, mapUID, map[string]any{"password": "abcd"})
	shareToken := share["token"].(string)
	if share["hasPassword"] != true {
		t.Fatalf("hasPassword = %#v，期望 true", share["hasPassword"])
	}

	// 1. 没凭证：401 SHARE_PASSWORD_REQUIRED，且**不返回文档**。
	status, body := s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil)
	if status != http.StatusUnauthorized || body.Error == nil || body.Error.Code != "SHARE_PASSWORD_REQUIRED" {
		t.Fatalf("无凭证读取 = %d %#v", status, body.Error)
	}
	if body.Data != nil {
		t.Fatalf("401 响应里不该有 data: %#v", body.Data)
	}

	// 2. 错密码：401 SHARE_PASSWORD_INVALID。
	status, body = s.do(http.MethodPost, "/api/v1/public/shares/"+shareToken+"/verify", "", map[string]any{"password": "wrong"})
	if status != http.StatusUnauthorized || body.Error.Code != "SHARE_PASSWORD_INVALID" {
		t.Fatalf("错密码 = %d %#v", status, body.Error)
	}

	// 3. 对密码：拿到 accessToken 与 1800 秒有效期。
	status, body = s.do(http.MethodPost, "/api/v1/public/shares/"+shareToken+"/verify", "", map[string]any{"password": "abcd"})
	if status != http.StatusOK {
		t.Fatalf("校验密码 = %d %#v", status, body.Error)
	}
	access, _ := body.Data["accessToken"].(string)
	if access == "" {
		t.Fatalf("没有返回 accessToken: %#v", body.Data)
	}
	if body.Data["expiresIn"] != float64(1800) {
		t.Fatalf("expiresIn = %#v，期望 1800", body.Data["expiresIn"])
	}

	// 4. 带凭证读取：200。
	status, body = s.doHeader(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil,
		map[string]string{"X-Share-Access": access})
	if status != http.StatusOK {
		t.Fatalf("带凭证读取 = %d %#v", status, body.Error)
	}
	if body.Data["title"] != "产品规划" {
		t.Fatalf("title = %#v", body.Data["title"])
	}

	// 5. 伪造的凭证同样按「需要密码」处理，不泄露它为什么无效。
	status, body = s.doHeader(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil,
		map[string]string{"X-Share-Access": "not-a-jwt"})
	if status != http.StatusUnauthorized || body.Error.Code != "SHARE_PASSWORD_REQUIRED" {
		t.Fatalf("伪造凭证 = %d %#v", status, body.Error)
	}
}

func TestShareOwnerCanReadAndResetPassword(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("alice")
	other := s.registerUser("bob")
	mapUID := s.createMap(owner, "密码管理")
	share := s.createShare(owner, mapUID, map[string]any{"password": "Ab9x"})
	uid := share["uid"].(string)
	if share["password"] != "Ab9x" {
		t.Fatalf("创建者应能查看密码，得到 %#v", share["password"])
	}
	for _, path := range []string{"/api/v1/maps/" + mapUID + "/shares", "/api/v1/shares"} {
		status, body := s.do(http.MethodGet, path, owner, nil)
		if status != http.StatusOK || len(body.Items) != 1 || body.Items[0]["password"] != "Ab9x" {
			t.Fatalf("属主密码列表 %s = %d %#v", path, status, body.Items)
		}
		req, _ := http.NewRequest(http.MethodGet, s.server.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+owner)
		resp, err := s.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("owner password response must not be cached")
		}
	}
	// Public verification and visits must not turn owner passwords into one-time values.
	for read := 0; read < 2; read++ {
		publicPath := "/api/v1/public/shares/" + share["token"].(string)
		status, verified := s.do(http.MethodPost, publicPath+"/verify", "", map[string]any{"password": "Ab9x"})
		if status != http.StatusOK {
			t.Fatalf("验证分享 = %d %#v", status, verified.Error)
		}
		status, public := s.doHeader(http.MethodGet, publicPath, "", nil, map[string]string{"X-Share-Access": verified.Data["accessToken"].(string)})
		if status != http.StatusOK {
			t.Fatalf("公开访问 = %d %#v", status, public.Error)
		}
		for _, key := range []string{"password", "passwordHash", "passwordCiphertext"} {
			if _, exists := public.Data[key]; exists {
				t.Fatalf("公开响应泄露 %s", key)
			}
		}
		for _, path := range []string{"/api/v1/maps/" + mapUID + "/shares", "/api/v1/shares"} {
			status, listed := s.do(http.MethodGet, path, owner, nil)
			if status != http.StatusOK || len(listed.Items) != 1 || listed.Items[0]["password"] != "Ab9x" {
				t.Fatalf("访问分享后密码不得消失 %s = %d", path, status)
			}
			status, listed = s.do(http.MethodGet, path, other, nil)
			if status != http.StatusNotFound && (status != http.StatusOK || len(listed.Items) != 0) {
				t.Fatalf("非属主列表泄露密码 %s = %d", path, status)
			}
		}
	}
	status, body := s.do(http.MethodPatch, "/api/v1/shares/"+uid, other, map[string]any{"password": "Cd8y"})
	if status != http.StatusNotFound {
		t.Fatalf("越权重设 = %d %#v", status, body.Error)
	}
	status, body = s.do(http.MethodPatch, "/api/v1/shares/"+uid, owner, map[string]any{"showNotes": true})
	if status != http.StatusOK || body.Data["password"] != "Ab9x" {
		t.Fatalf("省略密码必须保留 = %d %#v", status, body.Data)
	}
	status, body = s.do(http.MethodPatch, "/api/v1/shares/"+uid, owner, map[string]any{"password": "Cd8y"})
	if status != http.StatusOK || body.Data["password"] != "Cd8y" {
		t.Fatalf("重设密码 = %d %#v", status, body.Data)
	}
	status, body = s.do(http.MethodPatch, "/api/v1/shares/"+uid, owner, map[string]any{"password": nil})
	if status != http.StatusOK || body.Data["password"] != nil || body.Data["hasPassword"] != false {
		t.Fatalf("清空密码 = %d %#v", status, body.Data)
	}
	status, body = s.do(http.MethodGet, "/api/v1/public/shares/"+share["token"].(string), "", nil)
	if status != http.StatusOK {
		t.Fatalf("公开访问 = %d %#v", status, body.Error)
	}
	for _, key := range []string{"password", "passwordHash", "passwordCiphertext"} {
		if _, exists := body.Data[key]; exists {
			t.Fatalf("公开响应泄露 %s", key)
		}
	}
}

func TestShareNotesStrippedInHTTPResponse(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")

	status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"title": "带备注的图", "document": mapDocWithNotes("带备注的图", "内部备注内容"),
	})
	if status != http.StatusCreated {
		t.Fatalf("建图 = %d %#v", status, body.Error)
	}
	mapUID, _ := body.Data["uid"].(string)

	share := s.createShare(token, mapUID, map[string]any{"showNotes": false})
	shareToken := share["token"].(string)

	status, body = s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("公开读取 = %d %#v", status, body.Error)
	}
	raw, err := json.Marshal(body.Data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, forbidden := range []string{"内部备注内容", "do-not-leak", "top-level-secret", "wmind/9.9.9"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("响应里出现了 %q：%s", forbidden, raw)
		}
	}
}

func TestShareRevokeAndFourInvalidStates(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	mapUID := s.createMap(token, "产品规划")

	share := s.createShare(token, mapUID, map[string]any{})
	shareUID := share["uid"].(string)
	shareToken := share["token"].(string)

	// 撤销前可用。
	if status, _ := s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil); status != http.StatusOK {
		t.Fatalf("撤销前 = %d", status)
	}
	if status, body := s.do(http.MethodDelete, "/api/v1/shares/"+shareUID, token, nil); status != http.StatusNoContent {
		t.Fatalf("撤销 = %d %#v", status, body.Error)
	}

	// 撤销后：与「令牌不存在」返回完全相同的错误码与状态。
	status, revoked := s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil)
	if status != http.StatusNotFound || revoked.Error == nil || revoked.Error.Code != "SHARE_NOT_FOUND" {
		t.Fatalf("撤销后 = %d %#v", status, revoked.Error)
	}
	status, missing := s.do(http.MethodGet, "/api/v1/public/shares/definitely-not-a-token", "", nil)
	if status != http.StatusNotFound || missing.Error.Code != "SHARE_NOT_FOUND" {
		t.Fatalf("不存在的令牌 = %d %#v", status, missing.Error)
	}
	if revoked.Error.Message != missing.Error.Message {
		t.Fatalf("两种失效的提示语不同：%q vs %q", revoked.Error.Message, missing.Error.Message)
	}

	// 导图软删除：同样是 404。
	alive := s.createShare(token, mapUID, map[string]any{})
	aliveToken := alive["token"].(string)
	if status, body := s.do(http.MethodDelete, "/api/v1/maps/"+mapUID, token, nil); status != http.StatusNoContent {
		t.Fatalf("删除导图 = %d %#v", status, body.Error)
	}
	if status, body := s.do(http.MethodGet, "/api/v1/public/shares/"+aliveToken, "", nil); status != http.StatusNotFound {
		t.Fatalf("导图删除后 = %d %#v", status, body.Error)
	}
}

func TestShareSiteSwitchInvalidatesEverything(t *testing.T) {
	s := newAuthTestServer(t)
	adminToken := s.loginAs(testAdminEmail, testAdminPassword)
	userToken := s.registerUser("alice")
	mapUID := s.createMap(userToken, "产品规划")
	share := s.createShare(userToken, mapUID, map[string]any{})
	shareToken := share["token"].(string)

	// 关掉分享：历史链接立刻 403 SHARE_DISABLED（不是 404——前端要能说
	// 「站点已关闭分享」而不是「链接不存在」）。
	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", adminToken, map[string]any{
		"share.public_link_enabled": false,
	}); status != http.StatusOK {
		t.Fatalf("关闭分享 = %d %#v", status, body.Error)
	}
	status, body := s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil)
	if status != http.StatusForbidden || body.Error == nil || body.Error.Code != "SHARE_DISABLED" {
		t.Fatalf("关闭后读取 = %d %#v", status, body.Error)
	}

	// 新建链接也 403。
	status, body = s.do(http.MethodPost, "/api/v1/maps/"+mapUID+"/shares", userToken, map[string]any{})
	if status != http.StatusForbidden || body.Error.Code != "SHARE_DISABLED" {
		t.Fatalf("关闭后创建 = %d %#v", status, body.Error)
	}

	// site/config 里 shareEnabled 同步为 false，前端据此隐藏入口。
	status, body = s.do(http.MethodGet, "/api/v1/site/config", "", nil)
	if status != http.StatusOK || body.Data["shareEnabled"] != false {
		t.Fatalf("site/config shareEnabled = %#v", body.Data["shareEnabled"])
	}

	// 打开之后原链接恢复可用（撤销与过期才算永久失效）。
	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", adminToken, map[string]any{
		"share.public_link_enabled": true,
	}); status != http.StatusOK {
		t.Fatalf("打开分享 = %d %#v", status, body.Error)
	}
	if status, body := s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil); status != http.StatusOK {
		t.Fatalf("重新打开后 = %d %#v", status, body.Error)
	}
}

func TestShareUpdateOnlyTouchesProvidedFields(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	mapUID := s.createMap(token, "产品规划")

	share := s.createShare(token, mapUID, map[string]any{"password": "abcd", "expiresInDays": 7})
	shareUID := share["uid"].(string)

	// 只改 allowDownload：密码与有效期原样保留。
	status, body := s.do(http.MethodPatch, "/api/v1/shares/"+shareUID, token, map[string]any{
		"allowDownload": false,
	})
	if status != http.StatusOK {
		t.Fatalf("PATCH = %d %#v", status, body.Error)
	}
	if body.Data["allowDownload"] != false {
		t.Fatalf("allowDownload = %#v", body.Data["allowDownload"])
	}
	if body.Data["hasPassword"] != true {
		t.Fatal("密码被顺手清掉了")
	}
	if body.Data["expiresAt"] == nil {
		t.Fatal("有效期被顺手清掉了")
	}

	// password: null 表示清除密码（与「字段缺失」不同）。
	status, body = s.do(http.MethodPatch, "/api/v1/shares/"+shareUID, token, map[string]any{
		"password": nil,
	})
	if status != http.StatusOK {
		t.Fatalf("清密码 = %d %#v", status, body.Error)
	}
	if body.Data["hasPassword"] != false {
		t.Fatalf("hasPassword = %#v，期望 false", body.Data["hasPassword"])
	}

	// 清除之后可以直接匿名访问。
	shareToken := share["token"].(string)
	if status, body := s.do(http.MethodGet, "/api/v1/public/shares/"+shareToken, "", nil); status != http.StatusOK {
		t.Fatalf("清密码后读取 = %d %#v", status, body.Error)
	}
}

func TestShareListMineAndByMap(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")
	first := s.createMap(token, "产品规划")
	second := s.createMap(token, "另一张")

	s.createShare(token, first, map[string]any{})
	s.createShare(token, first, map[string]any{})
	s.createShare(token, second, map[string]any{})

	// 按导图列：只有这张图的两条。
	status, body := s.do(http.MethodGet, "/api/v1/maps/"+first+"/shares", token, nil)
	if status != http.StatusOK {
		t.Fatalf("按导图列 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 2 {
		t.Fatalf("按导图列 = %d 条，期望 2", len(body.Items))
	}
	for _, item := range body.Items {
		if item["mapUid"] != first {
			t.Fatalf("mapUid = %#v，期望 %q", item["mapUid"], first)
		}
		if item["mapTitle"] != "产品规划" {
			t.Fatalf("mapTitle = %#v", item["mapTitle"])
		}
	}

	// 我的分享：三条 + 分页信息。
	status, body = s.do(http.MethodGet, "/api/v1/shares", token, nil)
	if status != http.StatusOK {
		t.Fatalf("我的分享 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 3 {
		t.Fatalf("我的分享 = %d 条，期望 3", len(body.Items))
	}
	if body.Pagination == nil || body.Pagination.Total != 3 {
		t.Fatalf("分页信息不对: %#v", body.Pagination)
	}

	// map_uid 过滤。
	status, body = s.do(http.MethodGet, "/api/v1/shares?map_uid="+second, token, nil)
	if status != http.StatusOK {
		t.Fatalf("按 map_uid 过滤 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 1 {
		t.Fatalf("过滤后 = %d 条，期望 1", len(body.Items))
	}
}

func TestShareCrossUserIsolation(t *testing.T) {
	s := newAuthTestServer(t)
	aliceToken := s.registerUser("alice")
	bobToken := s.registerUser("bob")
	mapUID := s.createMap(aliceToken, "产品规划")
	share := s.createShare(aliceToken, mapUID, map[string]any{})
	shareUID := share["uid"].(string)

	// Bob 看不到 Alice 的导图分享（按导图列）。
	if status, body := s.do(http.MethodGet, "/api/v1/maps/"+mapUID+"/shares", bobToken, nil); status != http.StatusNotFound {
		t.Fatalf("跨用户按导图列 = %d %#v", status, body.Error)
	}
	// 也改不了、撤不了她的链接。
	if status, body := s.do(http.MethodPatch, "/api/v1/shares/"+shareUID, bobToken, map[string]any{
		"allowDownload": false,
	}); status != http.StatusNotFound {
		t.Fatalf("跨用户 PATCH = %d %#v", status, body.Error)
	}
	if status, body := s.do(http.MethodDelete, "/api/v1/shares/"+shareUID, bobToken, nil); status != http.StatusNotFound {
		t.Fatalf("跨用户撤销 = %d %#v", status, body.Error)
	}
	// 他的「我的分享」是空的。
	status, body := s.do(http.MethodGet, "/api/v1/shares", bobToken, nil)
	if status != http.StatusOK || len(body.Items) != 0 {
		t.Fatalf("Bob 的分享列表 = %d %d 条", status, len(body.Items))
	}
}
