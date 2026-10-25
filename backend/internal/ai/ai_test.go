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
	_, err := s.Save(t.Context(), Configuration{true, "https://provider.test/v1/", "key-must-stay-private", "model-a"}, false, nil)
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
	public, err := restarted.Save(t.Context(), Configuration{true, cfg.BaseURL, "", "model-b"}, false, nil)
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
		if _, err := s.Save(t.Context(), Configuration{false, base, "key", "m"}, false, nil); !apperr.Is(err, apperr.CodeAIConfigInvalid) {
			t.Fatalf("accepted %q", base)
		}
	}
	if _, err := s.Save(t.Context(), Configuration{Enabled: true}, false, nil); !apperr.Is(err, apperr.CodeAIConfigInvalid) {
		t.Fatal("enabled incomplete config")
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
		if len(messages) != 2 || messages[0].(map[string]any)["content"] != SystemPrompt || req["model"] != "custom-model" || req["response_format"] != nil || req["stream"] != false {
			t.Error("incompatible request")
		}
		user := messages[1].(map[string]any)["content"].(string)
		if !strings.Contains(user, "plan.docx") || !strings.Contains(user, "章节内容") || !strings.Contains(user, "生成项目计划") {
			t.Error("lost material")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "```json\n{\"title\":\" 项目计划 \",\"children\":[{\"title\":\"需求\",\"children\":[]}]}\n```"}, "finish_reason": "stop"}}})
	}))
	defer provider.Close()
	s := testService(t, &memorySettings{})
	in := GenerateInput{Prompt: "生成项目计划", Sources: []Source{{Name: "plan.docx", Text: "章节内容"}}}
	if _, err := s.Generate(t.Context(), in); !apperr.Is(err, apperr.CodeAIDisabled) || seen {
		t.Fatal("disabled called provider")
	}
	if _, err := s.Save(t.Context(), Configuration{true, provider.URL + "/prefix/v1/", "private-key", "custom-model"}, false, nil); err != nil {
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
	_, _ = s.Save(t.Context(), Configuration{true, provider.URL, "private-key", "m"}, false, nil)
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
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			t.Error("bad JSON")
		}
		var parts []contentPart
		if json.Unmarshal(req.Messages[1].Content, &parts) != nil || len(parts) != 3 || parts[2].ImageURL.URL != dataURL {
			t.Error("lost image part")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"image\",\"children\":[]}"},"finish_reason":"stop"}]}`))
	}))
	defer provider.Close()
	s := testService(t, &memorySettings{})
	_, _ = s.Save(t.Context(), Configuration{true, provider.URL + "/chat/completions", "key", "vision"}, false, nil)
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
	_, _ = s.Save(t.Context(), Configuration{true, redirect.URL, "key", "vision"}, false, nil)
	if _, err := s.Generate(t.Context(), GenerateInput{Prompt: "hello"}); !apperr.Is(err, apperr.CodeAIProviderFailed) || redirected {
		t.Fatal("followed provider redirect")
	}
}
