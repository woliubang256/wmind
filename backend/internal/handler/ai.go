package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/woliubang256/wmind/backend/internal/ai"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

type AIHandler struct {
	ai      *ai.Service
	auditor service.Auditor
	active  sync.Map
	slots   chan struct{}
}

func NewAIHandler(svc *ai.Service, auditor service.Auditor) *AIHandler {
	return &AIHandler{ai: svc, auditor: auditor, slots: make(chan struct{}, 4)}
}

func (h *AIHandler) Get(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	cfg, err := h.ai.Configuration(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, cfg.Public())
}

func decodeAIRequest(c *gin.Context, out any, limit int64) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		// Decoder errors can quote field names. Do not expose arbitrary request data.
		response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
		return false
	}
	if dec.Decode(new(any)) != io.EOF {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
		return false
	}
	return true
}

func (h *AIHandler) Save(c *gin.Context) {
	var req struct {
		Enabled         bool   `json:"enabled"`
		BaseURL         string `json:"baseUrl"`
		APIKey          string `json:"apiKey"`
		Model           string `json:"model"`
		ReasoningEffort string `json:"reasoningEffort"`
		ClearAPIKey     bool   `json:"clearApiKey"`
	}
	if !decodeAIRequest(c, &req, 32<<10) {
		return
	}
	cfg, err := h.ai.Save(c.Request.Context(), ai.Configuration{Enabled: req.Enabled, BaseURL: req.BaseURL, APIKey: req.APIKey, Model: req.Model, ReasoningEffort: req.ReasoningEffort}, req.ClearAPIKey, middleware.UserDBID(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	if h.auditor != nil {
		_ = h.auditor.Record(c.Request.Context(), service.AuditEntry{
			Actor:  service.Actor{ID: middleware.UserDBID(c), UID: middleware.UserID(c), IP: c.ClientIP()},
			Action: domain.AuditSettingsUpdate, TargetType: "settings", TargetID: "ai",
			Detail: map[string]any{"keys": []string{"ai.config"}},
		})
	}
	c.Header("Cache-Control", "no-store")
	response.OK(c, cfg)
}

func (h *AIHandler) Generate(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	if _, loaded := h.active.LoadOrStore(owner, true); loaded {
		response.Fail(c, apperr.New(apperr.CodeRateLimited, ""))
		return
	}
	defer h.active.Delete(owner)
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		response.Fail(c, apperr.New(apperr.CodeRateLimited, ""))
		return
	}
	var req ai.GenerateInput
	if !decodeAIRequest(c, &req, ai.MaxRequestBytes) {
		return
	}
	root, err := h.ai.Generate(c.Request.Context(), req)
	if err != nil {
		response.Fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	response.OK(c, root)
}
