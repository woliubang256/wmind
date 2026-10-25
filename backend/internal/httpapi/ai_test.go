package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/ai"
)

func TestAIConfigurationPermissionsAndFeatureGate(t *testing.T) {
	s := newAuthTestServer(t)
	user := s.registerUser("ai-user")
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if status, _ := s.do(method, "/api/v1/admin/ai", "", nil); status != 401 {
			t.Fatalf("anonymous config = %d", status)
		}
		if status, _ := s.do(method, "/api/v1/admin/ai", user, nil); status != 403 {
			t.Fatalf("user config = %d", status)
		}
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/ai/generate", "", map[string]any{"prompt": "plan"}); status != 401 {
		t.Fatalf("anonymous generate = %d", status)
	}
	status, body := s.do(http.MethodGet, "/api/v1/admin/ai", admin, nil)
	if status != 200 || body.Data["enabled"] != false || body.Data["systemPrompt"] != ai.SystemPrompt || body.Data["reasoningEffort"] != "" {
		t.Fatalf("defaults = %d %#v", status, body.Data)
	}
	status, body = s.do(http.MethodPost, "/api/v1/ai/generate", user, map[string]any{"prompt": "plan"})
	if status != 403 || body.Error.Code != "AI_DISABLED" {
		t.Fatalf("disabled generate = %d %#v", status, body.Error)
	}
	status, body = s.do(http.MethodPut, "/api/v1/admin/ai", admin, map[string]any{"systemPrompt": "replace me"})
	if status != 400 {
		t.Fatalf("editable prompt accepted = %d", status)
	}
	status, body = s.do(http.MethodGet, "/api/v1/site/config", "", nil)
	if status != 200 || body.Data["aiEnabled"] != false {
		t.Fatal("public flag must default false")
	}
}

func TestAIGeneratesTreeWithoutCreatingEmptyMap(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-private" {
			t.Error("wrong wire")
		}
		var req map[string]any
		if json.NewDecoder(r.Body).Decode(&req) != nil || req["reasoning_effort"] != "high" || req["model"] != "fixture-model" {
			t.Error("saved reasoning effort/model not sent to provider")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": `{"title":"计划","children":[{"title":"实施","children":[]}]}`}, "finish_reason": "stop"}}})
	}))
	defer provider.Close()
	s := newAuthTestServer(t)
	user := s.registerUser("ai-map-user")
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	status, body := s.do(http.MethodPut, "/api/v1/admin/ai", admin, map[string]any{"enabled": true, "baseUrl": provider.URL + "/v1", "apiKey": "fixture-private", "model": "fixture-model", "reasoningEffort": "high"})
	if status != 200 || body.Data["apiKeySet"] != true || body.Data["apiKey"] != nil || body.Data["reasoningEffort"] != "high" {
		t.Fatalf("save = %d %#v", status, body.Data)
	}
	status, body = s.do(http.MethodGet, "/api/v1/admin/ai", admin, nil)
	if status != 200 || body.Data["reasoningEffort"] != "high" {
		t.Fatal("reasoning effort not retained")
	}
	status, _ = s.do(http.MethodPut, "/api/v1/admin/ai", admin, map[string]any{"reasoningEffort": "unsupported"})
	if status != 422 {
		t.Fatalf("invalid reasoning effort = %d", status)
	}
	status, _ = s.do(http.MethodPost, "/api/v1/ai/generate", user, map[string]any{"prompt": "plan", "reasoningEffort": "none"})
	if status != 400 {
		t.Fatalf("user reasoning override = %d", status)
	}
	status, body = s.do(http.MethodGet, "/api/v1/site/config", "", nil)
	raw, _ := json.Marshal(body.Data)
	if status != 200 || body.Data["aiEnabled"] != true || strings.Contains(string(raw), "fixture-private") || strings.Contains(string(raw), "fixture-model") || body.Data["reasoningEffort"] != nil {
		t.Fatal("public response wrong")
	}
	status, body = s.do(http.MethodPost, "/api/v1/ai/generate", user, map[string]any{"prompt": "生成计划", "sources": []any{map[string]any{"name": "附件.docx", "text": "要求"}}})
	if status != 200 || body.Data["title"] != "计划" {
		t.Fatalf("generate = %d %#v", status, body)
	}
	status, body = s.do(http.MethodGet, "/api/v1/admin/settings", admin, nil)
	if status != 200 || body.Data["ai.config"] != nil {
		t.Fatal("private config entered general settings")
	}
	status, body = s.do(http.MethodPut, "/api/v1/admin/ai", admin, map[string]any{"enabled": false, "baseUrl": provider.URL + "/v1", "model": "fixture-model"})
	if status != 200 || body.Data["apiKeySet"] != true {
		t.Fatal("disabling lost provider key")
	}
	status, body = s.do(http.MethodPost, "/api/v1/ai/generate", user, map[string]any{"prompt": "plan"})
	if status != 403 {
		t.Fatal("feature gate remained open")
	}
}
