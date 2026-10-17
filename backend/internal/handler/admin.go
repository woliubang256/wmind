package handler

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// AdminHandler 处理管理后台接口。
type AdminHandler struct {
	admin *service.AdminService
}

// NewAdminHandler 构造管理 handler。
func NewAdminHandler(admin *service.AdminService) *AdminHandler {
	return &AdminHandler{admin: admin}
}

// actor 从请求上下文取出操作人。
func actor(c *gin.Context) service.Actor {
	return service.Actor{
		ID:  middleware.UserDBID(c),
		UID: middleware.UserID(c),
		IP:  c.ClientIP(),
	}
}

// ListUsers 处理 GET /api/v1/admin/users。
func (h *AdminHandler) ListUsers(c *gin.Context) {
	page, pageSize := paginationParams(c)
	in := domain.ListUsersInput{
		Keyword: strings.TrimSpace(c.Query("q")),
		Page:    domain.NewPage(page, pageSize),
	}
	if role := domain.Role(strings.TrimSpace(c.Query("role"))); role != "" {
		if !role.Valid() {
			response.Fail(c, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"role": "角色只能是 user 或 admin",
			}))
			return
		}
		in.Role = role
	}
	if status := domain.UserStatus(strings.TrimSpace(c.Query("status"))); status != "" {
		if !status.Valid() {
			response.Fail(c, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"status": "状态只能是 active / disabled / pending",
			}))
			return
		}
		in.Status = status
	}

	users, total, err := h.admin.ListUsers(c.Request.Context(), in)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]userDTO, 0, len(users))
	for _, user := range users {
		items = append(items, toUserDTO(user))
	}
	response.List(c, items, response.NewPagination(page, pageSize, total))
}

type createUserRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
	Role     string `json:"role"`
}

// CreateUser 处理 POST /api/v1/admin/users。
func (h *AdminHandler) CreateUser(c *gin.Context) {
	var req createUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	user, err := h.admin.CreateUser(c.Request.Context(), service.CreateUserInput{
		Username: req.Username, Email: req.Email, Password: req.Password,
		Nickname: req.Nickname, Role: domain.Role(req.Role),
	}, actor(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.Created(c, toUserDTO(user))
}

type updateUserRequest struct {
	Nickname *string `json:"nickname"`
	Email    *string `json:"email"`
	Role     *string `json:"role"`
	Status   *string `json:"status"`
}

// UpdateUser 处理 PATCH /api/v1/admin/users/{uid}。
func (h *AdminHandler) UpdateUser(c *gin.Context) {
	var req updateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}

	patch := service.AdminUserPatch{Nickname: req.Nickname, Email: req.Email}
	if req.Role != nil {
		role := domain.Role(*req.Role)
		if !role.Valid() {
			response.Fail(c, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"role": "角色只能是 user 或 admin",
			}))
			return
		}
		patch.Role = &role
	}
	if req.Status != nil {
		status := domain.UserStatus(*req.Status)
		if !status.Valid() {
			response.Fail(c, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"status": "状态只能是 active / disabled / pending",
			}))
			return
		}
		patch.Status = &status
	}

	user, err := h.admin.UpdateUser(c.Request.Context(), c.Param("uid"), patch, actor(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toUserDTO(user))
}

// DeleteUser 处理 DELETE /api/v1/admin/users/{uid}。
//
// map_strategy 一期只做取值校验：导图表在 M2 才有，现在没有可处理的对象。
func (h *AdminHandler) DeleteUser(c *gin.Context) {
	if strategy := c.Query("map_strategy"); strategy != "" && strategy != "delete" && strategy != "keep" {
		response.Fail(c, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"map_strategy": "只能是 delete 或 keep",
		}))
		return
	}
	if err := h.admin.DeleteUser(c.Request.Context(), c.Param("uid"), actor(c)); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}

type resetPasswordRequest struct {
	Password string `json:"password"`
}

// resetPasswordResponse 是一次性返回的新密码。
//
// 这个响应体是本期唯一能看到明文密码的地方；服务端只存哈希，
// 关掉对话框后就再也查不到（验收标准 7）。
type resetPasswordResponse struct {
	Password  string `json:"password"`
	Generated bool   `json:"generated"`
}

// ResetPassword 处理 POST /api/v1/admin/users/{uid}/reset-password。
func (h *AdminHandler) ResetPassword(c *gin.Context) {
	var req resetPasswordRequest
	// 空请求体等价于「帮我随机生成」，所以解析失败只在 body 非空时才报错。
	if c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
			return
		}
	}
	result, err := h.admin.ResetPassword(c.Request.Context(), c.Param("uid"), req.Password, actor(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, resetPasswordResponse{Password: result.Password, Generated: result.Generated})
}

// Stats 处理 GET /api/v1/admin/stats。
func (h *AdminHandler) Stats(c *gin.Context) {
	stats, err := h.admin.Stats(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, stats)
}

type auditLogDTO struct {
	ID         int64  `json:"id"`
	ActorID    *int64 `json:"actorId"`
	Action     string `json:"action"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Detail     any    `json:"detail"`
	IP         string `json:"ip"`
	CreatedAt  string `json:"createdAt"`
}

// ListAuditLogs 处理 GET /api/v1/admin/audit-logs。
func (h *AdminHandler) ListAuditLogs(c *gin.Context) {
	page, pageSize := paginationParams(c)
	query := service.AuditQuery{
		Action:   strings.TrimSpace(c.Query("action")),
		ActorUID: strings.TrimSpace(c.Query("actor_uid")),
		Page:     domain.NewPage(page, pageSize),
	}
	if from, ok := parseQueryTime(c.Query("from")); ok {
		query.From = &from
	}
	if to, ok := parseQueryTime(c.Query("to")); ok {
		query.To = &to
	}

	logs, total, err := h.admin.ListAuditLogs(c.Request.Context(), query)
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]auditLogDTO, 0, len(logs))
	for _, entry := range logs {
		items = append(items, auditLogDTO{
			ID: entry.ID, ActorID: entry.ActorID, Action: entry.Action,
			TargetType: entry.TargetType, TargetID: entry.TargetID,
			// detail 是 JSON 文本；原样透传会让前端拿到一个字符串再自己 parse。
			// 这里解开成对象，解不开就退回字符串（历史数据可能不是合法 JSON）。
			Detail:    decodeDetail(entry.Detail),
			IP:        entry.IP,
			CreatedAt: formatTime(entry.CreatedAt),
		})
	}
	response.List(c, items, response.NewPagination(page, pageSize, total))
}

// decodeDetail 把审计 detail 的 JSON 文本还原成对象。
func decodeDetail(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	var out any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return raw
	}
	return out
}

// paginationParams 读取 page / page_size 查询参数。
//
// 非法值一律回落到默认值而不是报错：分页参数越界属于调用方的疏忽，
// 返回一个合理的页比返回 422 更有用。
func paginationParams(c *gin.Context) (int, int) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", strconv.Itoa(domain.DefaultPageSize)))
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 || pageSize > domain.MaxPageSize {
		pageSize = domain.DefaultPageSize
	}
	return page, pageSize
}

// parseQueryTime 解析 RFC3339 或纯日期（2026-10-17）。
func parseQueryTime(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}
