package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// AdminSettingsHandler 处理管理员的站点设置接口。
type AdminSettingsHandler struct {
	settings *settings.Service
}

// NewAdminSettingsHandler 构建设置 handler。
func NewAdminSettingsHandler(svc *settings.Service) *AdminSettingsHandler {
	return &AdminSettingsHandler{settings: svc}
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
	response.OK(c, snapshot.All())
}
