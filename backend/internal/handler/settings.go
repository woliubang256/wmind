package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// AdminSettingsHandler 处理管理员的站点设置接口。
type AdminSettingsHandler struct {
	settings *settings.Service
	// auditor 记录设置变更。为 nil 时不审计（单测里常见）。
	auditor service.Auditor
}

// NewAdminSettingsHandler 构建设置 handler。
//
// auditor 单独传而不是让 settings 包依赖审计：settings 是「值 + 校验」的
// 纯逻辑，审计是「谁在什么时候改了它」的横切关注点，混在一起会让
// settings 的单元测试也要准备一个假审计仓储。
func NewAdminSettingsHandler(svc *settings.Service, auditor service.Auditor) *AdminSettingsHandler {
	return &AdminSettingsHandler{settings: svc, auditor: auditor}
}

// maxSettingsBody 限制请求体大小。
//
// 设置项只有 20 个左右，1MB 已经宽裕到不可能被正常请求触发；限制它是为了
// 让「把整个 PDF 当 JSON 提交」这类误用立刻失败而不是先读进内存。
const maxSettingsBody = 1 << 20

// Get 处理 GET /api/v1/admin/settings。
//
// 返回全量键值（含敏感项），前端据此渲染分组表单。
func (h *AdminSettingsHandler) Get(c *gin.Context) {
	response.OK(c, h.settings.Snapshot().All())
}

// Update 处理 PUT /api/v1/admin/settings。
//
// 部分更新：只校验并写入请求里出现的键，未出现的保持原值。
func (h *AdminSettingsHandler) Update(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSettingsBody)
	dec := json.NewDecoder(c.Request.Body)
	// UseNumber：默认会把数字解成 float64，而设置项是整数。走 Number 才能
	// 把「1.5」与「1」区分开——前者应报类型错误，不该被静默截断成 1。
	dec.UseNumber()

	var patch map[string]any
	if err := dec.Decode(&patch); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	// 只接受一个 JSON 对象：后面还有内容说明请求体拼接错了。
	if err := dec.Decode(new(any)); err != io.EOF {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, "请求体必须是单个 JSON 对象"))
		return
	}

	snapshot, err := h.settings.Update(c.Request.Context(), patch, middleware.UserDBID(c))
	if err != nil {
		response.Fail(c, err)
		return
	}

	// 只记改了哪些键，不记值：site.* 之外还有可能被误填敏感内容的键，
	// 而「谁在什么时候改了哪些设置」已经足够回答审计问题。
	if h.auditor != nil {
		keys := make([]string, 0, len(patch))
		for key := range patch {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		_ = h.auditor.Record(c.Request.Context(), service.AuditEntry{
			Actor: service.Actor{
				ID:  middleware.UserDBID(c),
				UID: middleware.UserID(c),
				IP:  c.ClientIP(),
			},
			Action:     domain.AuditSettingsUpdate,
			TargetType: "settings",
			TargetID:   "site",
			Detail:     map[string]any{"keys": keys},
		})
	}
	response.OK(c, snapshot.All())
}
