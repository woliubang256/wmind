package handler

import (
	"encoding/json"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// ThemeHandler 处理自定义主题接口。
type ThemeHandler struct {
	themes *service.ThemeService
}

// NewThemeHandler 构造主题 handler。
func NewThemeHandler(themes *service.ThemeService) *ThemeHandler {
	return &ThemeHandler{themes: themes}
}

// themeDTO 是一条自定义主题。
//
// Config 用 json.RawMessage 原样透出：它已经是合法 JSON（写入前校验过），
// 再解成 map[string]any 只会多一次解析与一次分配，还会把数字变成 float64。
//
// 不带 ownerId：调用方只可能是属主本人，回显一个内部自增主键毫无用处。
type themeDTO struct {
	UID       string          `json:"uid"`
	Name      string          `json:"name"`
	Category  string          `json:"category"`
	Config    json.RawMessage `json:"config"`
	SortOrder int             `json:"sortOrder"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

func toThemeDTO(t *domain.Theme) themeDTO {
	config := json.RawMessage(t.Config)
	if len(config) == 0 {
		config = json.RawMessage("null")
	}
	return themeDTO{
		UID: t.UID, Name: t.Name, Category: t.Category, Config: config,
		SortOrder: t.SortOrder,
		CreatedAt: formatTime(t.CreatedAt), UpdatedAt: formatTime(t.UpdatedAt),
	}
}

// List 处理 GET /api/v1/themes。
//
// 只返回当前用户的自定义主题。内置的 10 套配色是前端包内的静态资源，
// 不走这里——编辑器首帧就要解析样式，等不了一个请求（docs/04 §5.5）。
func (h *ThemeHandler) List(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	themes, err := h.themes.List(c.Request.Context(), owner)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]themeDTO, 0, len(themes))
	for _, t := range themes {
		items = append(items, toThemeDTO(t))
	}
	// 不分页：上限 50 条、每条几 KB，一页装得下。但仍然走 response.List
	// 而不是裸数组——信封形状与 /maps 一致，前端才能复用同一个 apiList，
	// 否则每加一个列表接口就要多一条解析分支。
	response.List(c, items, response.NewPagination(1, len(items), int64(len(items))))
}

type themeRequest struct {
	Name   string          `json:"name"`
	Config json.RawMessage `json:"config"`
}

// bindThemeRequest 解析并做「字段在不在」这一层检查。
//
// 业务校验（长度、颜色格式）在 service 里——那里才有领域知识。
func bindThemeRequest(c *gin.Context) (themeRequest, bool) {
	var req themeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return req, false
	}
	if len(req.Config) == 0 {
		response.Fail(c, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"config": "缺少主题配置",
		}))
		return req, false
	}
	return req, true
}

// Create 处理 POST /api/v1/themes。
func (h *ThemeHandler) Create(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	req, ok := bindThemeRequest(c)
	if !ok {
		return
	}
	created, err := h.themes.Create(c.Request.Context(), owner, service.CreateThemeInput{
		Name: req.Name, Config: req.Config,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.Created(c, toThemeDTO(created))
}

// Update 处理 PUT /api/v1/themes/{uid}。
func (h *ThemeHandler) Update(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	req, ok := bindThemeRequest(c)
	if !ok {
		return
	}
	updated, err := h.themes.Update(c.Request.Context(), owner, c.Param("uid"), service.UpdateThemeInput{
		Name: req.Name, Config: req.Config,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toThemeDTO(updated))
}

// Delete 处理 DELETE /api/v1/themes/{uid}。
func (h *ThemeHandler) Delete(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	if err := h.themes.Delete(c.Request.Context(), owner, c.Param("uid")); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}
