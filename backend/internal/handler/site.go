package handler

import (
	"context"
	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// SiteHandler 处理公开的站点配置接口。
type SiteHandler struct {
	settings *settings.Service
	// version 是构建版本，前端用来判断是否需要提示刷新。
	version   string
	aiEnabled func(context.Context) bool
}

// NewSiteHandler 构造站点配置 handler。
func NewSiteHandler(svc *settings.Service, version string, aiEnabled ...func(context.Context) bool) *SiteHandler {
	h := &SiteHandler{settings: svc, version: version}
	if len(aiEnabled) > 0 {
		h.aiEnabled = aiEnabled[0]
	}
	return h
}

// siteConfig 是 GET /site/config 的响应体（docs/04 §5.1）。
//
// 字段逐个列出而不是直接把快照的 map 吐出去：这个接口未登录可访问，
// 白名单式地写清楚「哪些键会出去」，比「从 map 里过滤掉敏感的」更难出错。
type siteConfig struct {
	SiteName string `json:"siteName"`
	// Brand 是导出图片右下角的落款。已经解析过「留空 = 站点名称」，
	// 前端直接拿去用，不必再判断一次空串。
	Brand               string `json:"brand"`
	LogoURL             string `json:"logoUrl"`
	Description         string `json:"description"`
	ICP                 string `json:"icp"`
	RegistrationEnabled bool   `json:"registrationEnabled"`
	PasswordMinLength   int    `json:"passwordMinLength"`
	ImportEnabled       bool   `json:"importEnabled"`
	AIEnabled           bool   `json:"aiEnabled"`
	ExportEnabled       bool   `json:"exportEnabled"`
	UserTemplateEnabled bool   `json:"userTemplateEnabled"`
	ShareEnabled        bool   `json:"shareEnabled"`
	// 两个分享默认值：新建分享对话框要按站点策略预填，否则后台配的
	// `share.default_expire_days` 就是一条改了没反应的设置。
	ShareDefaultExpireDays    int    `json:"shareDefaultExpireDays"`
	ShareDefaultAllowDownload bool   `json:"shareDefaultAllowDownload"`
	Version                   string `json:"version"`
}

// Config 处理 GET /api/v1/site/config。
//
// 前端启动时调用，用来决定是否显示注册入口、密码规则提示与分享页文案。
func (h *SiteHandler) Config(c *gin.Context) {
	snapshot := h.settings.Snapshot()
	response.OK(c, siteConfig{
		SiteName:            snapshot.SiteName(),
		Brand:               snapshot.BrandName(),
		LogoURL:             snapshot.String("site.logo"),
		Description:         snapshot.String("site.description"),
		ICP:                 snapshot.String("site.icp"),
		RegistrationEnabled: snapshot.RegistrationEnabled(),
		PasswordMinLength:   snapshot.PasswordMinLength(),
		ImportEnabled:       snapshot.Bool("feature.import_enabled"),
		AIEnabled:           h.aiEnabled != nil && h.aiEnabled(c.Request.Context()),
		ExportEnabled:       snapshot.Bool("feature.export_enabled"),
		UserTemplateEnabled: snapshot.Bool("feature.user_template_enabled"),
		ShareEnabled:        snapshot.Bool("share.public_link_enabled"),
		// 这两个只是**新建链接时的预填值**，不参与任何鉴权判断，所以可以
		// 公开。真正的强制项（require_password / max_links_per_map）留在
		// 服务端，不下发——下发了只会让前端多一条可能与服务端不一致的规则。
		ShareDefaultExpireDays:    snapshot.Int("share.default_expire_days"),
		ShareDefaultAllowDownload: snapshot.Bool("share.default_allow_download"),
		Version:                   h.version,
	})
}
