package handler

import (
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// ShareHandler 处理分享链接与公开访问接口。
type ShareHandler struct {
	shares   *service.ShareService
	settings *settings.Service
	// auditor 记录创建与撤销。为 nil 时不审计（测试装配可以不给）。
	auditor service.Auditor
}

// NewShareHandler 构造分享 handler。
func NewShareHandler(shares *service.ShareService, site *settings.Service, auditor service.Auditor) *ShareHandler {
	return &ShareHandler{shares: shares, settings: site, auditor: auditor}
}

// shareDTO 是一条分享链接的对外形态。
//
// 含 token 明文：属主需要随时复制链接，而能读到这个 DTO 的人本来就已经
// 是属主（所有管理接口都带 owner_id 谓词）。它不会出现在任何列表的公开
// 响应里。
type shareDTO struct {
	UID           string  `json:"uid"`
	Token         string  `json:"token"`
	URL           string  `json:"url"`
	MapUID        string  `json:"mapUid"`
	MapTitle      string  `json:"mapTitle"`
	HasPassword   bool    `json:"hasPassword"`
	Password      *string `json:"password"`
	AllowDownload bool    `json:"allowDownload"`
	ShowNotes     bool    `json:"showNotes"`
	ExpiresAt     *string `json:"expiresAt"`
	ViewCount     int     `json:"viewCount"`
	LastViewedAt  *string `json:"lastViewedAt"`
	RevokedAt     *string `json:"revokedAt"`
	CreatedAt     string  `json:"createdAt"`
}

func (h *ShareHandler) toDTO(link *domain.ShareLink) shareDTO {
	return shareDTO{
		UID: link.UID, Token: link.Token, URL: h.shares.ShareURL(link.Token),
		MapUID: link.MapUID, MapTitle: link.MapTitle,
		HasPassword:   link.HasPassword(),
		Password:      link.Password,
		AllowDownload: link.AllowDownload,
		ShowNotes:     link.ShowNotes,
		ExpiresAt:     formatTimePtr(link.ExpiresAt),
		ViewCount:     link.ViewCount,
		LastViewedAt:  formatTimePtr(link.LastViewedAt),
		RevokedAt:     formatTimePtr(link.RevokedAt),
		CreatedAt:     formatTime(link.CreatedAt),
	}
}

type createShareRequest struct {
	Password      string `json:"password"`
	ExpiresInDays int    `json:"expiresInDays"`
	// 两个开关用指针：省略时按「允许下载、显示备注」处理。用裸 bool 的话，
	// 省略和显式 false 无法区分，默认值会静默变成「不允许」。
	AllowDownload *bool `json:"allowDownload"`
	ShowNotes     *bool `json:"showNotes"`
}

// Create 处理 POST /api/v1/maps/{uid}/shares。
func (h *ShareHandler) Create(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req createShareRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	created, err := h.shares.Create(c.Request.Context(), c.Param("uid"), owner, service.CreateShareInput{
		Password:      req.Password,
		ExpiresInDays: req.ExpiresInDays,
		AllowDownload: req.AllowDownload == nil || *req.AllowDownload,
		ShowNotes:     req.ShowNotes == nil || *req.ShowNotes,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.record(c, domain.AuditShareCreate, created, map[string]any{
		"hasPassword":   created.HasPassword(),
		"allowDownload": created.AllowDownload,
		"showNotes":     created.ShowNotes,
		"expiresAt":     formatTimePtr(created.ExpiresAt),
	})
	response.Created(c, h.toDTO(created))
}

// ListByMap 处理 GET /api/v1/maps/{uid}/shares。
func (h *ShareHandler) ListByMap(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	list, err := h.shares.ListByMap(c.Request.Context(), c.Param("uid"), owner)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]shareDTO, 0, len(list))
	for _, link := range list {
		items = append(items, h.toDTO(link))
	}
	// 不分页：一张导图的链接上限是站点设置里的 max_links_per_map（默认 20），
	// 天然有界，加一层分页只会让前端的「分享管理」对话框多一次翻页。
	response.OK(c, items)
}

// ListMine 处理 GET /api/v1/shares（「我的分享」）。
func (h *ShareHandler) ListMine(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	page, pageSize := pageParams(c)
	list, total, err := h.shares.ListMine(c.Request.Context(), owner, c.Query("map_uid"), page, pageSize)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]shareDTO, 0, len(list))
	for _, link := range list {
		items = append(items, h.toDTO(link))
	}
	response.List(c, items, response.NewPagination(page, pageSize, total))
}

type updateShareRequest struct {
	// password 用 RawMessage 而不是 *string：省略表示「不改」，null 表示
	// 「清除密码」，字符串表示「改成这个」。*string 会把前两者都变成 nil，
	// 于是「只想关掉允许下载」会顺手把密码清掉。
	Password      json.RawMessage `json:"password"`
	ExpiresInDays *int            `json:"expiresInDays"`
	AllowDownload *bool           `json:"allowDownload"`
	ShowNotes     *bool           `json:"showNotes"`
}

// Update 处理 PATCH /api/v1/shares/{uid}。
func (h *ShareHandler) Update(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	var req updateShareRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	password, err := optionalPassword(req.Password)
	if err != nil {
		response.Fail(c, err)
		return
	}
	updated, err := h.shares.Update(c.Request.Context(), c.Param("uid"), owner, service.UpdateShareInput{
		Password:      password,
		ExpiresInDays: req.ExpiresInDays,
		AllowDownload: req.AllowDownload,
		ShowNotes:     req.ShowNotes,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, h.toDTO(updated))
}

// Revoke 处理 DELETE /api/v1/shares/{uid}。
func (h *ShareHandler) Revoke(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	uid := c.Param("uid")
	if err := h.shares.Revoke(c.Request.Context(), uid, owner); err != nil {
		response.Fail(c, err)
		return
	}
	// 撤销之后 detail 里没有 token：审计表是 append-only，一个已经失效的
	// 令牌仍然没必要留在里面。
	h.record(c, domain.AuditShareRevoke, &domain.ShareLink{UID: uid}, nil)
	response.NoContent(c)
}

// publicShareDTO 是公开访问的响应体（docs/04 §5.7）。
//
// 不含 owner.uid / 邮箱，也不含 map uid：分享页只需要「这是什么图、谁分享的」。
type publicShareDTO struct {
	Title         string          `json:"title"`
	Document      json.RawMessage `json:"document"`
	AllowDownload bool            `json:"allowDownload"`
	ShowNotes     bool            `json:"showNotes"`
	SiteName      string          `json:"siteName"`
	LogoURL       string          `json:"logoUrl"`
	OwnerNickname string          `json:"ownerNickname"`
	CreatedAt     string          `json:"createdAt"`
	ExpiresAt     *string         `json:"expiresAt"`
}

// PublicGet 处理 GET /api/v1/public/shares/{token}。
func (h *ShareHandler) PublicGet(c *gin.Context) {
	// 分享可以随时被撤销，缓存一份文档就等于让撤销延迟到缓存过期——
	// 「撤销后立即失效」是验收标准里明写的一条。
	c.Header("Cache-Control", "no-store")

	access := c.GetHeader("X-Share-Access")
	payload, err := h.shares.ReadPublic(c.Request.Context(), c.Param("token"), access, c.ClientIP())
	if err != nil {
		response.Fail(c, err)
		return
	}
	document, err := service.ShareDocumentAssets(payload.Document, c.Param("token"), access)
	if err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeInternalError, err))
		return
	}
	snapshot := h.settings.Snapshot()
	response.OK(c, publicShareDTO{
		Title:         payload.Title,
		Document:      json.RawMessage(document),
		AllowDownload: payload.AllowDownload,
		ShowNotes:     payload.ShowNotes,
		SiteName:      snapshot.SiteName(),
		LogoURL:       snapshot.String("site.logo"),
		OwnerNickname: payload.OwnerNickname,
		CreatedAt:     formatTime(payload.CreatedAt),
		ExpiresAt:     formatTimePtr(payload.ExpiresAt),
	})
}

type verifyShareRequest struct {
	Password string `json:"password"`
}

type verifyShareResponse struct {
	AccessToken string `json:"accessToken"`
	ExpiresIn   int    `json:"expiresIn"`
}

// PublicVerify 处理 POST /api/v1/public/shares/{token}/verify。
func (h *ShareHandler) PublicVerify(c *gin.Context) {
	c.Header("Cache-Control", "no-store")

	var req verifyShareRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	token, expiresIn, err := h.shares.VerifyPassword(c.Request.Context(), c.Param("token"), req.Password)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, verifyShareResponse{AccessToken: token, ExpiresIn: expiresIn})
}

// record 写一条分享相关的审计记录。
//
// 失败只记日志、不影响响应（由 service.Auditor 的实现决定）：链接已经建好
// 了，因为审计写不进去就返回 500 会让用户重试，而重试会再建一条。
func (h *ShareHandler) record(c *gin.Context, action string, link *domain.ShareLink, detail map[string]any) {
	if h.auditor == nil {
		return
	}
	if detail == nil {
		detail = map[string]any{}
	}
	// 导图 uid 让审计能回答「谁分享了哪张图」，它本身不是凭证。
	if link.MapUID != "" {
		detail["mapUid"] = link.MapUID
	}
	_ = h.auditor.Record(c.Request.Context(), service.AuditEntry{
		Actor: service.Actor{
			ID:  middleware.UserDBID(c),
			UID: middleware.UserID(c),
			IP:  c.ClientIP(),
		},
		Action:     action,
		TargetType: "share",
		TargetID:   link.UID,
		Detail:     detail,
	})
}

// optionalPassword 解析 PATCH 里的 password 字段。
//
// 三种形态：字段缺失 → nil（不改）；null → 指向空串（清除密码）；
// 字符串 → 指向该值。前端「清除密码」的语义就靠这一层区分。
func optionalPassword(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if strings.TrimSpace(string(raw)) == "null" {
		empty := ""
		return &empty, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"password": "应为字符串或 null",
		})
	}
	return &value, nil
}
