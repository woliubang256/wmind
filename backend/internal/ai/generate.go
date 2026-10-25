package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	_ "golang.org/x/image/webp"

	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

const (
	MaxRequestBytes = 12 << 20
	MaxTextRunes    = 100000
	MaxImages       = 12
	maxOutputBytes  = 1 << 20
	MaxNodes        = 500
	MaxDepth        = 12
)

type Source struct {
	Name   string   `json:"name"`
	Text   string   `json:"text"`
	Images []string `json:"images"`
}

type GenerateInput struct {
	Prompt  string   `json:"prompt"`
	Sources []Source `json:"sources"`
}

type Node struct {
	Title    string `json:"title"`
	Children []Node `json:"children"`
}

type contentPart struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *imageURL `json:"image_url,omitempty"`
}
type imageURL struct {
	URL string `json:"url"`
}

// ValidateInput checks limits on the server even when the browser extracted files.
func ValidateInput(in GenerateInput) error {
	bad := func() error { return apperr.New(apperr.CodeAIInputInvalid, "") }
	if len(in.Sources) > 5 || !utf8.ValidString(in.Prompt) {
		return bad()
	}
	textRunes, images, imageBytes := utf8.RuneCountInString(in.Prompt), 0, 0
	hasContent := strings.TrimSpace(in.Prompt) != ""
	for _, source := range in.Sources {
		if len(source.Name) > 1024 || !utf8.ValidString(source.Text) {
			return bad()
		}
		textRunes += utf8.RuneCountInString(source.Text)
		if strings.TrimSpace(source.Text) == "" && len(source.Images) == 0 {
			return bad()
		}
		hasContent = true
		for _, data := range source.Images {
			images++
			if images > MaxImages || len(data) > 3<<20 {
				return bad()
			}
			prefix, encoded, ok := strings.Cut(data, ",")
			mime := strings.TrimSuffix(strings.TrimPrefix(prefix, "data:"), ";base64")
			if !ok || prefix != "data:"+mime+";base64" || (mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" && mime != "image/gif") {
				return bad()
			}
			raw, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return bad()
			}
			imageBytes += len(raw)
			cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
			if err != nil || "image/"+format != mime || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 4096 || cfg.Height > 4096 || int64(cfg.Width)*int64(cfg.Height) > 16000000 || imageBytes > 8<<20 {
				return bad()
			}
		}
	}
	if !hasContent || textRunes > MaxTextRunes {
		return bad()
	}
	return nil
}

func endpoint(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	return base + "/chat/completions"
}

func (s *Service) Generate(ctx context.Context, in GenerateInput) (*Node, error) {
	cfg, err := s.Configuration(ctx)
	if err != nil {
		return nil, err
	}
	if !cfg.Enabled {
		return nil, apperr.New(apperr.CodeAIDisabled, "")
	}
	if err := ValidateInput(in); err != nil {
		return nil, err
	}
	parts := []contentPart{{Type: "text", Text: "用户要求：\n" + in.Prompt}}
	for _, source := range in.Sources {
		parts = append(parts, contentPart{Type: "text", Text: "附件素材（" + source.Name + "）：\n" + source.Text})
		for _, url := range source.Images {
			parts = append(parts, contentPart{Type: "image_url", ImageURL: &imageURL{URL: url}})
		}
	}
	// The fixed format instructions follow every user-supplied material part.
	parts = append(parts, contentPart{Type: "text", Text: SystemPrompt})
	// Plain strings preserve compatibility with text-only providers.
	var userContent any = parts
	hasImages := false
	for _, part := range parts {
		if part.ImageURL != nil {
			hasImages = true
		}
	}
	if !hasImages {
		texts := make([]string, 0, len(parts))
		for _, part := range parts {
			texts = append(texts, part.Text)
		}
		userContent = strings.Join(texts, "\n\n")
	}
	payload := map[string]any{
		"model": cfg.Model, "stream": false,
		"messages": []map[string]any{{"role": "user", "content": userContent}},
	}
	if cfg.ReasoningEffort != "" {
		payload["reasoning_effort"] = cfg.ReasoningEffort
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(cfg.BaseURL), bytes.NewReader(body))
	if err != nil {
		return nil, apperr.New(apperr.CodeAIConfigInvalid, "")
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		// Do not wrap errors containing a URL; URLs may contain provider credentials.
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, apperr.New(apperr.CodeAIProviderFailed, "")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, apperr.New(apperr.CodeAIProviderFailed, "").WithDetail("status", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxOutputBytes+1))
	if err != nil || len(raw) > maxOutputBytes {
		return nil, apperr.New(apperr.CodeAIOutputInvalid, "")
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.Unmarshal(raw, &completion) != nil || len(completion.Choices) != 1 || completion.Choices[0].FinishReason == "length" || completion.Choices[0].FinishReason == "content_filter" {
		return nil, apperr.New(apperr.CodeAIOutputInvalid, "")
	}
	return parseTree(completion.Choices[0].Message.Content)
}

func parseTree(content string) (*Node, error) {
	invalid := func() (*Node, error) { return nil, apperr.New(apperr.CodeAIOutputInvalid, "") }
	content = strings.TrimSpace(content)
	// Some compatible models wrap JSON despite the instruction. Accept only a
	// complete enclosing fence, never search arbitrary prose for a JSON fragment.
	if strings.HasPrefix(content, "```json\n") && strings.HasSuffix(content, "\n```") {
		content = strings.TrimSuffix(strings.TrimPrefix(content, "```json\n"), "\n```")
	} else if strings.HasPrefix(content, "```\n") && strings.HasSuffix(content, "\n```") {
		content = strings.TrimSuffix(strings.TrimPrefix(content, "```\n"), "\n```")
	}
	dec := json.NewDecoder(strings.NewReader(content))
	dec.DisallowUnknownFields()
	var root *Node
	if dec.Decode(&root) != nil || root == nil || dec.Decode(new(any)) != io.EOF {
		return invalid()
	}
	count := 0
	var validate func(*Node, int) bool
	validate = func(node *Node, depth int) bool {
		count++
		node.Title = strings.TrimSpace(node.Title)
		limit := 500
		if depth == 1 {
			limit = 200
		}
		if count > MaxNodes || depth > MaxDepth || node.Title == "" || utf8.RuneCountInString(node.Title) > limit {
			return false
		}
		if node.Children == nil {
			node.Children = []Node{}
		}
		for i := range node.Children {
			if !validate(&node.Children[i], depth+1) {
				return false
			}
		}
		return true
	}
	if !validate(root, 1) {
		return invalid()
	}
	return root, nil
}
