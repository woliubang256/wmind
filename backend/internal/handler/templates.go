package handler

import (
	"encoding/json"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// TemplateHandler 处理用户模板接口。
type TemplateHandler struct {
	templates *service.TemplateService
}

// NewTemplateHandler 构造模板 handler。
func NewTemplateHandler(templates *service.TemplateService) *TemplateHandler {
	return &TemplateHandler{templates: templates}
}

// templateSummaryDTO 是列表里的一条模板。
//
// **没有 document**：一份文档可能到 8 MiB，列表只需要名字、结构与缩略图。
// 需要文档的场景（用模板新建导图）走 GET /templates/{uid} 单独取一次。
//
// 不带 ownerId：调用方只可能是属主本人，回显一个内部自增主键毫无用处。
type templateSummaryDTO struct {
	UID          string `json:"uid"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	Structure    string `json:"structure"`
	ThumbnailURL string `json:"thumbnailUrl"`
	IsBuiltin    bool   `json:"isBuiltin"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

// templateDetailDTO 在摘要之上带完整文档。
type templateDetailDTO struct {
	templateSummaryDTO
	Document json.RawMessage `json:"document"`
}

func toTemplateSummary(t *domain.Template) templateSummaryDTO {
	return templateSummaryDTO{
		UID: t.UID, Name: t.Name, Category: t.Category, Structure: t.Structure,
		ThumbnailURL: t.ThumbnailURL, IsBuiltin: t.IsBuiltin,
		CreatedAt: formatTime(t.CreatedAt), UpdatedAt: formatTime(t.UpdatedAt),
	}
}

func toTemplateDetail(t *domain.Template) templateDetailDTO {
	document := json.RawMessage(t.Document)
	if len(document) == 0 {
		// 不该发生：文档列 NOT NULL。留一个合法的空对象，好过让整个响应
		// 因为一个 null 在前端 parseDocument 里炸掉。
		document = json.RawMessage("{}")
	}
	return templateDetailDTO{templateSummaryDTO: toTemplateSummary(t), Document: document}
}

// List 处理 GET /api/v1/templates。
//
// 只返回当前用户的模板。内置的 8 个模板是前端包内的静态资源，不走这里
// ——模板选择对话框要渲染实时预览，等不了一个请求（docs/04 §5.4）。
func (h *TemplateHandler) List(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	templates, err := h.templates.List(c.Request.Context(), owner)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]templateSummaryDTO, 0, len(templates))
	for _, t := range templates {
		items = append(items, toTemplateSummary(t))
	}
	// 不分页：上限 50 条、每条几百字节，一页装得下。但仍然走 response.List
	// 而不是裸数组——信封形状与 /maps 一致，前端才能复用同一个 apiList。
	response.List(c, items, response.NewPagination(1, len(items), int64(len(items))))
}

// Get 处理 GET /api/v1/templates/{uid}，返回含文档的完整模板。
func (h *TemplateHandler) Get(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	found, err := h.templates.Get(c.Request.Context(), owner, c.Param("uid"))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toTemplateDetail(found))
}

type createTemplateRequest struct {
	Name   string `json:"name"`
	MapUID string `json:"mapUid"`
}

// Create 处理 POST /api/v1/templates（从导图另存为模板）。
func (h *TemplateHandler) Create(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req createTemplateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	created, err := h.templates.CreateFromMap(c.Request.Context(), owner, service.CreateFromMapInput{
		Name: req.Name, MapUID: req.MapUID,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.Created(c, toTemplateDetail(created))
}

type renameTemplateRequest struct {
	Name string `json:"name"`
}

// Rename 处理 PATCH /api/v1/templates/{uid}。
func (h *TemplateHandler) Rename(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req renameTemplateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	updated, err := h.templates.Rename(c.Request.Context(), owner, c.Param("uid"), req.Name)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toTemplateSummary(updated))
}

// Delete 处理 DELETE /api/v1/templates/{uid}。
func (h *TemplateHandler) Delete(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	if err := h.templates.Delete(c.Request.Context(), owner, c.Param("uid")); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}
