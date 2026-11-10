package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// fakeMaps 是内存版导图能力，够覆盖全部工具。
type fakeMaps struct {
	rows   map[string]*domain.Map
	nextID int
	saves  int
}

func newFakeMaps() *fakeMaps { return &fakeMaps{rows: map[string]*domain.Map{}} }

func (f *fakeMaps) List(_ context.Context, ownerID int64, keyword string, _ domain.MapSort, _, pageSize int) ([]*domain.Map, int64, error) {
	var out []*domain.Map
	for _, row := range f.rows {
		if row.OwnerID != ownerID {
			continue
		}
		if keyword != "" && !strings.Contains(row.Title, keyword) {
			continue
		}
		out = append(out, row)
	}
	if pageSize < len(out) {
		out = out[:pageSize]
	}
	return out, int64(len(out)), nil
}

func (f *fakeMaps) Get(_ context.Context, uid string, ownerID int64) (*domain.Map, error) {
	row, ok := f.rows[uid]
	if !ok || row.OwnerID != ownerID {
		return nil, errors.New("not found")
	}
	return row, nil
}

func (f *fakeMaps) Create(_ context.Context, ownerID int64, in service.CreateMapInput) (*domain.Map, error) {
	f.nextID++
	row := &domain.Map{
		UID: "map-new", OwnerID: ownerID, Title: in.Title, Document: in.Document,
		Version: 1, UpdatedAt: time.Now(),
	}
	f.rows[row.UID] = row
	return row, nil
}

func (f *fakeMaps) Save(_ context.Context, uid string, ownerID int64, in service.SaveMapInput) (*domain.Map, error) {
	row, ok := f.rows[uid]
	if !ok || row.OwnerID != ownerID {
		return nil, errors.New("not found")
	}
	if row.Version != in.Version {
		return nil, errors.New("version conflict")
	}
	f.saves++
	row.Document = in.Document
	row.Title = in.Title
	row.Version++
	return row, nil
}

func newTestServer(t *testing.T, token string) (http.Handler, *fakeMaps) {
	t.Helper()
	maps := newFakeMaps()
	maps.rows["map-1"] = &domain.Map{
		UID: "map-1", OwnerID: 7, Title: "产品规划", Version: 3,
		Document: []byte(sampleDoc), UpdatedAt: time.Now(),
	}
	handler := New(Deps{
		Maps:    maps,
		Token:   token,
		Owner:   func(context.Context) (int64, error) { return 7, nil },
		Version: "1.1.4",
	})
	return handler, maps
}

func call(t *testing.T, handler http.Handler, token, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	out := map[string]any{}
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	return rec, out
}

// 没开（token 为空）或令牌不对，一律 401。
func TestRequiresToken(t *testing.T) {
	handler, _ := newTestServer(t, "")
	if rec, _ := call(t, handler, "", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("未开启时应 401，实际 %d", rec.Code)
	}
	handler, _ = newTestServer(t, "secret")
	if rec, _ := call(t, handler, "wrong", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("令牌错误应 401，实际 %d", rec.Code)
	}
	if rec, _ := call(t, handler, "secret", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`); rec.Code != http.StatusOK {
		t.Fatalf("令牌正确应 200，实际 %d", rec.Code)
	}
}

func TestInitializeAndToolsList(t *testing.T) {
	handler, _ := newTestServer(t, "secret")
	_, out := call(t, handler, "secret", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	result := out["result"].(map[string]any)
	if result["protocolVersion"] != "2025-06-18" {
		t.Fatalf("协议版本不对: %v", result["protocolVersion"])
	}
	info := result["serverInfo"].(map[string]any)
	if info["name"] != "wmind" || info["version"] != "1.1.4" {
		t.Fatalf("serverInfo 不对: %v", info)
	}

	_, list := call(t, handler, "secret", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := list["result"].(map[string]any)["tools"].([]any)
	names := map[string]bool{}
	for _, raw := range tools {
		names[raw.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"list_maps", "get_map", "create_map", "update_map_title", "add_topic", "update_topic", "delete_topic"} {
		if !names[want] {
			t.Fatalf("缺少工具 %s（实际 %v）", want, names)
		}
	}
}

func TestToolCalls(t *testing.T) {
	handler, maps := newTestServer(t, "secret")

	// get_map 返回大纲树
	_, out := call(t, handler, "secret", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_map","arguments":{"uid":"map-1"}}}`)
	text := out["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "产品规划") || !strings.Contains(text, "用户研究") {
		t.Fatalf("大纲内容不对: %s", text)
	}

	// add_topic 真的写进了文档
	_, out = call(t, handler, "secret", `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_topic","arguments":{"uid":"map-1","parent_id":"b","title":"灰度发布"}}}`)
	if out["result"].(map[string]any)["isError"] != false {
		t.Fatalf("加主题失败: %v", out)
	}
	if !strings.Contains(string(maps.rows["map-1"].Document), "灰度发布") {
		t.Fatal("新主题没有写进文档")
	}

	// update_topic 改文字
	_, out = call(t, handler, "secret", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"update_topic","arguments":{"uid":"map-1","topic_id":"b","title":"发布计划"}}}`)
	if out["result"].(map[string]any)["isError"] != false {
		t.Fatalf("改文字失败: %v", out)
	}
	if !strings.Contains(string(maps.rows["map-1"].Document), "发布计划") {
		t.Fatal("标题没改到")
	}

	// delete_topic 删子树
	_, out = call(t, handler, "secret", `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delete_topic","arguments":{"uid":"map-1","topic_id":"a"}}}`)
	if out["result"].(map[string]any)["isError"] != false {
		t.Fatalf("删主题失败: %v", out)
	}
	if strings.Contains(string(maps.rows["map-1"].Document), "访谈") {
		t.Fatal("子树没删干净")
	}

	// create_map 新建
	_, out = call(t, handler, "secret", `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_map","arguments":{"outline":"新图\n  分支"}}}`)
	text = out["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "map-new") {
		t.Fatalf("新建结果不对: %s", text)
	}
}

// 工具失败按 MCP 约定放在结果里（isError），不是协议错误。
func TestToolFailureIsResult(t *testing.T) {
	handler, _ := newTestServer(t, "secret")
	_, out := call(t, handler, "secret", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_map","arguments":{"uid":"missing"}}}`)
	result := out["result"].(map[string]any)
	if result["isError"] != true {
		t.Fatalf("应当返回 isError: %v", result)
	}
}

func TestUnknownMethod(t *testing.T) {
	handler, _ := newTestServer(t, "secret")
	_, out := call(t, handler, "secret", `{"jsonrpc":"2.0","id":1,"method":"resources/list"}`)
	rpcErr := out["error"].(map[string]any)
	if int(rpcErr["code"].(float64)) != codeMethodNotFound {
		t.Fatalf("错误码不对: %v", rpcErr)
	}
}
