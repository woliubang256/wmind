package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

type memorySettings struct{ rows []*domain.Setting }

func (m *memorySettings) List(context.Context) ([]*domain.Setting, error) { return m.rows, nil }
func (m *memorySettings) Upsert(_ context.Context, key, value string, _ *int64, _ time.Time) error {
	m.rows = []*domain.Setting{{Key: key, Value: value}}
	return nil
}
func testService(t *testing.T, repo *memorySettings) *Service {
	t.Helper()
	s, err := New(repo, strings.Repeat("test-secret-", 4))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestConfigurationEncryptedMaskedAndReloadable(t *testing.T) {
	repo := &memorySettings{}
	s := testService(t, repo)
	if s.Enabled(t.Context()) {
		t.Fatal("AI must default to disabled")
	}
	_, err := s.Save(t.Context(), Configuration{Enabled: true, BaseURL: "https://provider.test/v1/", APIKey: "key-must-stay-private", Model: "model-a"}, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(repo.rows[0].Value, "key-must-stay-private") || strings.Contains(repo.rows[0].Value, "provider.test") {
		t.Fatal("stored plaintext")
	}
	restarted := testService(t, repo)
	cfg, err := restarted.Configuration(t.Context())
	if err != nil || cfg.BaseURL != "https://provider.test/v1" || cfg.APIKey != "key-must-stay-private" {
		t.Fatalf("restart: %#v %v", cfg.Public(), err)
	}
	public, err := restarted.Save(t.Context(), Configuration{Enabled: true, BaseURL: cfg.BaseURL, Model: "model-b"}, false, nil)
	raw, _ := json.Marshal(public)
	if err != nil || !public.APIKeySet || public.SystemPrompt != SystemPrompt || strings.Contains(string(raw), cfg.APIKey) {
		t.Fatalf("masked save: %s %v", raw, err)
	}
	updated, _ := s.Configuration(t.Context())
	if updated.Model != "model-b" || updated.APIKey != cfg.APIKey {
		t.Fatal("other instance failed to read update or lost key")
	}
	wrongKey, _ := New(repo, strings.Repeat("different-secret", 3))
	if _, err := wrongKey.Configuration(t.Context()); !apperr.Is(err, apperr.CodeAIConfigInvalid) {
		t.Fatal("wrong key was accepted")
	}
	if _, err := s.Save(t.Context(), Configuration{}, true, nil); err != nil {
		t.Fatal(err)
	}
	if s.Enabled(t.Context()) {
		t.Fatal("clear and disable failed")
	}
}

func TestConfigurationRejectsInvalidEndpointsAndIncompleteEnable(t *testing.T) {
	s := testService(t, &memorySettings{})
	for _, base := range []string{"ftp://provider.test", "https://user:secret@provider.test", "https://provider.test?api_key=secret", "https://provider.test#fragment", ":bad"} {
		if _, err := s.Save(t.Context(), Configuration{BaseURL: base, APIKey: "key", Model: "m"}, false, nil); !apperr.Is(err, apperr.CodeAIConfigInvalid) {
			t.Fatalf("accepted %q", base)
		}
	}
	if _, err := s.Save(t.Context(), Configuration{Enabled: true}, false, nil); !apperr.Is(err, apperr.CodeAIConfigInvalid) {
		t.Fatal("enabled incomplete config")
	}
}

func TestConfigurationReasoningEffortValidationAndLegacyDefault(t *testing.T) {
	repo := &memorySettings{}
	s := testService(t, repo)
	// Deliberately seal the pre-reasoning configuration shape, not today's struct.
	plain := []byte(`{"enabled":false,"baseUrl":"https://provider.test/v1","apiKey":"legacy-key","model":"legacy-model"}`)
	nonce := make([]byte, s.box.NonceSize())
	stored, _ := json.Marshal(base64.StdEncoding.EncodeToString(s.box.Seal(nonce, nonce, plain, []byte(configKey))))
	repo.rows = []*domain.Setting{{Key: configKey, Value: string(stored)}}
	legacy, err := s.Configuration(t.Context())
	if err != nil || legacy.ReasoningEffort != "" || legacy.APIKey != "legacy-key" || legacy.Model != "legacy-model" {
		t.Fatalf("legacy config: %#v %v", legacy.Public(), err)
	}
	for _, effort := range []string{"", "none", "minimal", "low", "medium", "high", "xhigh", "max"} {
		public, err := s.Save(t.Context(), Configuration{BaseURL: legacy.BaseURL, Model: legacy.Model, ReasoningEffort: effort}, false, nil)
		if err != nil || public.ReasoningEffort != effort || !public.APIKeySet {
			t.Fatalf("save effort %q: %#v %v", effort, public, err)
		}
		reloaded, err := testService(t, repo).Configuration(t.Context())
		if err != nil || reloaded.ReasoningEffort != effort || reloaded.APIKey != legacy.APIKey {
			t.Fatalf("reload effort %q: %#v %v", effort, reloaded.Public(), err)
		}
	}
	for _, effort := range []string{"auto", "HIGH", " high ", "null", "disabled"} {
		before := repo.rows[0].Value
		if _, err := s.Save(t.Context(), Configuration{ReasoningEffort: effort}, false, nil); !apperr.Is(err, apperr.CodeAIConfigInvalid) || repo.rows[0].Value != before {
			t.Fatalf("invalid effort %q changed config: %v", effort, err)
		}
	}
}

func TestGenerateReasoningEffortWire(t *testing.T) {
	for _, effort := range []string{"", "none", "minimal", "low", "medium", "high", "xhigh", "max"} {
		t.Run("effort="+effort, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
				}
				raw, present := req["reasoning_effort"]
				if effort == "" {
					if present {
						t.Error("default must omit reasoning_effort, not null or none")
					}
				} else if string(raw) != `"`+effort+`"` {
					t.Errorf("expected explicit %q, got %s", effort, raw)
				}
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"plan\",\"children\":[]}"},"finish_reason":"stop"}]}`))
			}))
			defer provider.Close()
			s := testService(t, &memorySettings{})
			if _, err := s.Save(t.Context(), Configuration{Enabled: true, BaseURL: provider.URL, APIKey: "private-key", Model: "configured-model", ReasoningEffort: effort}, false, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Generate(t.Context(), GenerateInput{Prompt: "plan"}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestGenerateUnsupportedReasoningEffortDoesNotRetry(t *testing.T) {
	requests := make(chan struct{}, 4)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("unsupported reasoning_effort: private diagnostics"))
	}))
	defer provider.Close()
	s := testService(t, &memorySettings{})
	_, err := s.Save(t.Context(), Configuration{Enabled: true, BaseURL: provider.URL, APIKey: "key", Model: "unchanged-model", ReasoningEffort: "max"}, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Generate(t.Context(), GenerateInput{Prompt: "plan"}); !apperr.Is(err, apperr.CodeAIProviderFailed) || strings.Contains(err.Error(), "diagnostics") {
		t.Fatalf("provider failure: %v", err)
	}
	if len(requests) != 1 {
		t.Fatalf("retried paid call %d times", len(requests))
	}
	cfg, _ := s.Configuration(t.Context())
	if cfg.Model != "unchanged-model" || cfg.ReasoningEffort != "max" {
		t.Fatal("silently downgraded configuration")
	}
}

func TestGenerateUsesCompatibleWireAndValidatedTree(t *testing.T) {
	var seen bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = true
		if r.URL.Path != "/prefix/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer private-key" {
			t.Error("wrong endpoint or authorization")
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		messages := req["messages"].([]any)
		if len(messages) != 1 || messages[0].(map[string]any)["role"] != "user" || req["model"] != "custom-model" || req["response_format"] != nil || req["stream"] != false {
			t.Error("incompatible request")
		}
		user := messages[0].(map[string]any)["content"].(string)
		if !strings.Contains(user, "plan.docx") || !strings.Contains(user, "章节内容") || !strings.Contains(user, "生成项目计划") {
			t.Error("lost material")
		}
		if !strings.HasPrefix(user, "用户要求：\n生成项目计划") || !strings.HasSuffix(user, "\n\n"+SystemPrompt) || strings.Count(user, SystemPrompt) != 1 {
			t.Error("fixed prompt must be appended after user input and all material")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "```json\n{\"title\":\" 项目计划 \",\"children\":[{\"title\":\"需求\",\"children\":[]}]}\n```"}, "finish_reason": "stop"}}})
	}))
	defer provider.Close()
	s := testService(t, &memorySettings{})
	in := GenerateInput{Prompt: "生成项目计划", Sources: []Source{{Name: "plan.docx", Text: "章节内容"}}}
	if _, err := s.Generate(t.Context(), in); !apperr.Is(err, apperr.CodeAIDisabled) || seen {
		t.Fatal("disabled called provider")
	}
	if _, err := s.Save(t.Context(), Configuration{Enabled: true, BaseURL: provider.URL + "/prefix/v1/", APIKey: "private-key", Model: "custom-model"}, false, nil); err != nil {
		t.Fatal(err)
	}
	root, err := s.Generate(t.Context(), in)
	if err != nil || root.Title != "项目计划" || root.Children[0].Title != "需求" {
		t.Fatalf("tree: %#v %v", root, err)
	}
}

func TestGenerateFailureIsRedactedAndCancellationPropagates(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte("private-key and provider debug details"))
	}))
	defer provider.Close()
	s := testService(t, &memorySettings{})
	_, _ = s.Save(t.Context(), Configuration{Enabled: true, BaseURL: provider.URL, APIKey: "private-key", Model: "m"}, false, nil)
	_, err := s.Generate(t.Context(), GenerateInput{Prompt: "hello"})
	if !apperr.Is(err, apperr.CodeAIProviderFailed) || strings.Contains(err.Error(), "private-key") {
		t.Fatal("provider error leaked")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.Generate(ctx, GenerateInput{Prompt: "hello"}); err != context.Canceled {
		t.Fatalf("cancel: %v", err)
	}
}

func TestRejectsInvalidMaterialAndModelTrees(t *testing.T) {
	for _, input := range []GenerateInput{
		{}, {Prompt: strings.Repeat("字", MaxTextRunes+1)}, {Sources: []Source{{Name: "empty.pdf"}}},
		{Sources: []Source{{Images: []string{"https://external.test/image.png"}}}},
		{Sources: []Source{{Images: []string{"data:image/png;base64,YmFk"}}}},
	} {
		if ValidateInput(input) == nil {
			t.Fatal("invalid material accepted")
		}
	}
	for _, content := range []string{"null", "[]", `{"title":""}`, `{"title":"ok","html":"<script>"}`, `{"title":"ok"} {"title":"extra"}`, `{"title":"x","children":[null]}`} {
		if _, err := parseTree(content); !apperr.Is(err, apperr.CodeAIOutputInvalid) {
			t.Fatalf("accepted %s", content)
		}
	}
	root := Node{Title: "root", Children: make([]Node, MaxNodes)}
	for i := range root.Children {
		root.Children[i].Title = "child"
	}
	raw, _ := json.Marshal(root)
	if _, err := parseTree(string(raw)); err == nil {
		t.Fatal("node limit not enforced")
	}
	content := `{"title":"leaf"}`
	for range MaxDepth {
		content = `{"title":"branch","children":[` + content + `]}`
	}
	if _, err := parseTree(content); err == nil {
		t.Fatal("depth limit not enforced")
	}
}

func TestGenerateSendsActualImageAndRejectsRedirect(t *testing.T) {
	var pngData bytes.Buffer
	_ = png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngData.Bytes())
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			t.Error("bad JSON")
		}
		var parts []contentPart
		if len(req.Messages) != 1 || req.Messages[0].Role != "user" {
			t.Error("must send material then appended prompt in one user message")
		}
		if json.Unmarshal(req.Messages[0].Content, &parts) != nil || len(parts) != 4 || parts[2].ImageURL == nil || parts[2].ImageURL.URL != dataURL || parts[3].Type != "text" || parts[3].Text != SystemPrompt {
			t.Error("lost image part")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"image\",\"children\":[]}"},"finish_reason":"stop"}]}`))
	}))
	defer provider.Close()
	s := testService(t, &memorySettings{})
	_, _ = s.Save(t.Context(), Configuration{Enabled: true, BaseURL: provider.URL + "/chat/completions", APIKey: "key", Model: "vision"}, false, nil)
	if _, err := s.Generate(t.Context(), GenerateInput{Sources: []Source{{Name: "image.png", Images: []string{dataURL}}}}); err != nil {
		t.Fatal(err)
	}
	if ValidateInput(GenerateInput{Sources: []Source{{Images: []string{strings.Replace(dataURL, "image/png", "image/jpeg", 1)}}}}) == nil {
		t.Fatal("false mime accepted")
	}
	redirected := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer redirect.Close()
	_, _ = s.Save(t.Context(), Configuration{Enabled: true, BaseURL: redirect.URL, APIKey: "key", Model: "vision"}, false, nil)
	if _, err := s.Generate(t.Context(), GenerateInput{Prompt: "hello"}); !apperr.Is(err, apperr.CodeAIProviderFailed) || redirected {
		t.Fatal("followed provider redirect")
	}
}
