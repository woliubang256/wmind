package handler

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// MapHandler 处理导图相关接口。
type MapHandler struct {
	maps *service.MapService
}

// NewMapHandler 构造导图 handler。
func NewMapHandler(maps *service.MapService) *MapHandler {
	return &MapHandler{maps: maps}
}

// mapSummaryDTO 是列表项。
//
// 不含 document：列表一页 20 张图、每张 1 MB 的话响应体就是 20 MB，
// 而列表页只需要标题与缩略图（docs/04 §5.3）。
type mapSummaryDTO struct {
	UID          string  `json:"uid"`
	Title        string  `json:"title"`
	ThumbnailURL string  `json:"thumbnailUrl"`
	NodeCount    int     `json:"nodeCount"`
	SizeBytes    int64   `json:"sizeBytes"`
	Version      int     `json:"version"`
	Deleted      bool    `json:"deleted"`
	DeletedAt    *string `json:"deletedAt,omitempty"`
	ExpiresAt    *string `json:"expiresAt,omitempty"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

// mapDetailDTO 是详情，比列表项多 document。
//
// Document 用 json.RawMessage：它已经是合法 JSON（写入前校验过），
// 再解成 map[string]any 只会白白多一次解析与一次分配。
type mapDetailDTO struct {
	mapSummaryDTO
	Document json.RawMessage `json:"document"`
}

// saveResultDTO 是保存接口的响应。
//
// 只回版本号与时间，不回整份文档：自动保存每隔几秒一次，把 1 MB 的文档
// 原样回传是纯粹的带宽浪费——客户端本来就有那份文档。
type saveResultDTO struct {
	UID       string `json:"uid"`
	Version   int    `json:"version"`
	NodeCount int    `json:"nodeCount"`
	UpdatedAt string `json:"updatedAt"`
}

func toMapSummaryDTO(m *domain.Map) mapSummaryDTO {
	return mapSummaryDTO{
		UID:          m.UID,
		Title:        m.Title,
		ThumbnailURL: m.ThumbnailURL,
		NodeCount:    m.NodeCount,
		SizeBytes:    m.SizeBytes,
		Version:      m.Version,
		Deleted:      m.IsTrashed(),
		DeletedAt:    formatMapDeletionTime(m.DeletedAt),
		CreatedAt:    formatTime(m.CreatedAt),
		UpdatedAt:    formatTime(m.UpdatedAt),
	}
}

// Preserve the repository timestamp precision at retention boundaries.
func formatMapDeletionTime(at *time.Time) *string {
	if at == nil {
		return nil
	}
	value := at.UTC().Format(time.RFC3339Nano)
	return &value
}

func toMapDetailDTO(m *domain.Map) mapDetailDTO {
	document := json.RawMessage(m.Document)
	if len(document) == 0 {
		document = json.RawMessage("null")
	}
	return mapDetailDTO{mapSummaryDTO: toMapSummaryDTO(m), Document: document}
}

// List 处理 GET /api/v1/maps。
//
// `sort` 只在这里解析一次：未知值回落到「最近修改」而不是 422。排序是展示
// 偏好，用户从旧版前端或手改地址栏带进来一个陌生值时，给他一页正常内容
// 比给他一个错误页有用。
func (h *MapHandler) List(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	page, pageSize := pageParams(c)
	maps, total, err := h.maps.List(c.Request.Context(), owner, c.Query("q"), domain.ParseMapSort(c.Query("sort")), page, pageSize)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]mapSummaryDTO, 0, len(maps))
	for _, m := range maps {
		items = append(items, toMapSummaryDTO(m))
	}
	response.List(c, items, response.NewPagination(page, pageSize, total))
}

type createMapRequest struct {
	Title    string          `json:"title"`
	Document json.RawMessage `json:"document"`
}

// Create 处理 POST /api/v1/maps。
func (h *MapHandler) Create(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req createMapRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	if len(req.Document) == 0 {
		response.Fail(c, apperr.New(apperr.CodeDocumentInvalid, "").
			WithDetail("reason", "缺少 document"))
		return
	}
	created, err := h.maps.Create(c.Request.Context(), owner, service.CreateMapInput{
		Title:    req.Title,
		Document: req.Document,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.Created(c, toMapDetailDTO(created))
}

// Get 处理 GET /api/v1/maps/{uid}。
func (h *MapHandler) Get(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	found, err := h.maps.Get(c.Request.Context(), c.Param("uid"), owner)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toMapDetailDTO(found))
}

type saveMapRequest struct {
	Version  int             `json:"version"`
	Title    string          `json:"title"`
	Document json.RawMessage `json:"document"`
}

// Save 处理 PUT /api/v1/maps/{uid}。
func (h *MapHandler) Save(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req saveMapRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	if req.Version <= 0 {
		// 版本号缺失是客户端 bug，不是用户输入错误。让它显式失败而不是
		// 当成 0 去匹配——后者永远匹配不上，用户会看到「冲突」而不是
		// 「请求不合法」，排查方向会跑偏。
		response.Fail(c, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"version": "缺少版本号",
		}))
		return
	}
	saved, err := h.maps.Save(c.Request.Context(), c.Param("uid"), owner, service.SaveMapInput{
		Version:  req.Version,
		Title:    req.Title,
		Document: req.Document,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, saveResultDTO{
		UID:       saved.UID,
		Version:   saved.Version,
		NodeCount: saved.NodeCount,
		UpdatedAt: formatTime(saved.UpdatedAt),
	})
}

type renameMapRequest struct {
	Title string `json:"title"`
}

// Rename 处理 PATCH /api/v1/maps/{uid}。
func (h *MapHandler) Rename(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req renameMapRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	updated, err := h.maps.Rename(c.Request.Context(), c.Param("uid"), owner, req.Title)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toMapSummaryDTO(updated))
}

type updateThumbnailRequest struct {
	ThumbnailURL string `json:"thumbnailUrl"`
}

// UpdateThumbnail 处理 PUT /api/v1/maps/{uid}/thumbnail。
//
// 与保存接口分开：自动保存手里没有缩略图，而缩略图是在渲染稳定之后才由
// 前端截图上传的。合成一条路径的话，两边都会互相覆盖。
func (h *MapHandler) UpdateThumbnail(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req updateThumbnailRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	if err := h.maps.UpdateThumbnail(c.Request.Context(), c.Param("uid"), owner, req.ThumbnailURL); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}

// Delete 处理 DELETE /api/v1/maps/{uid}（软删除进回收站）。
func (h *MapHandler) Delete(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	if err := h.maps.Delete(c.Request.Context(), c.Param("uid"), owner); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}

// Duplicate 处理 POST /api/v1/maps/{uid}/duplicate。
func (h *MapHandler) Duplicate(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	created, err := h.maps.Duplicate(c.Request.Context(), c.Param("uid"), owner)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.Created(c, toMapDetailDTO(created))
}

// ListTrash 处理 GET /api/v1/trash。
func (h *MapHandler) ListTrash(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	page, pageSize := pageParams(c)
	maps, total, err := h.maps.ListTrash(c.Request.Context(), owner, page, pageSize)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]mapSummaryDTO, 0, len(maps))
	retention := time.Duration(h.maps.TrashRetentionDays()) * 24 * time.Hour
	for _, m := range maps {
		item := toMapSummaryDTO(m)
		if m.DeletedAt != nil {
			expiresAt := m.DeletedAt.Add(retention)
			item.ExpiresAt = formatMapDeletionTime(&expiresAt)
		}
		items = append(items, item)
	}
	response.List(c, items, response.NewPagination(page, pageSize, total))
}

// Restore 处理 POST /api/v1/trash/{uid}/restore。
func (h *MapHandler) Restore(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	restored, err := h.maps.Restore(c.Request.Context(), c.Param("uid"), owner)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toMapSummaryDTO(restored))
}

// Purge 处理 DELETE /api/v1/trash/{uid}。
func (h *MapHandler) Purge(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	if err := h.maps.Purge(c.Request.Context(), c.Param("uid"), owner); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}

// EmptyTrash 处理 DELETE /api/v1/trash。
func (h *MapHandler) EmptyTrash(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	if err := h.maps.EmptyTrash(c.Request.Context(), owner); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}

// ownerID 取当前用户的内部主键。
//
// 导图表的 owner_id 是 int64 外键（内部表用自增主键比字符串省空间也省索引），
// 而对外一律用 uid。取不到说明 RequireAuth 没有正常执行——那是中间件链被
// 改坏了，不是用户的问题，所以按未认证处理而不是 500。
func ownerID(c *gin.Context) (int64, bool) {
	id := middleware.UserDBID(c)
	if id == nil {
		response.Fail(c, apperr.New(apperr.CodeAuthTokenInvalid, ""))
		return 0, false
	}
	return *id, true
}

// pageParams 解析分页参数。
//
// 解析失败时用默认值而不是报错：`?page=abc` 更可能是用户手改地址栏，
// 让他看到第一页比看到 400 更有用。
func pageParams(c *gin.Context) (int, int) {
	page, err := strconv.Atoi(c.Query("page"))
	if err != nil {
		page = 1
	}
	pageSize, err := strconv.Atoi(c.Query("page_size"))
	if err != nil {
		pageSize = domain.DefaultPageSize
	}
	return page, pageSize
}
