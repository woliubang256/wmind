package handler

import (
	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// SiteHandler 处理公开的站点配置接口。
type SiteHandler struct {
	settings *settings.Service
	// version 是构建版本，前端用来判断是否需要提示刷新。
	version string
}

// NewSiteHandler 构造站点配置 handler。
func NewSiteHandler(svc *settings.Service, version string) *SiteHandler {
	return &SiteHandler{settings: svc, version: version}
}

// siteConfig 是 GET /site/config 的响应体（docs/04 §5.1）。
//
// 字段逐个列出而不是直接把快照的 map 吐出去：这个接口未登录可访问，
// 白名单式地写清楚「哪些键会出去」，比「从 map 里过滤掉敏感的」更难出错。
type siteConfig struct {
	SiteName            string `json:"siteName"`
	LogoURL             string `json:"logoUrl"`
	Description         string `json:"description"`
	ICP                 string `json:"icp"`
	RegistrationEnabled bool   `json:"registrationEnabled"`
	PasswordMinLength   int    `json:"passwordMinLength"`
	ImportEnabled       bool   `json:"importEnabled"`
	ExportEnabled       bool   `json:"exportEnabled"`
	UserTemplateEnabled bool   `json:"userTemplateEnabled"`
	ShareEnabled        bool   `json:"shareEnabled"`
	Version             string `json:"version"`
}

// Config 处理 GET /api/v1/site/config。
//
// 前端启动时调用，用来决定是否显示注册入口、密码规则提示与分享页文案。
func (h *SiteHandler) Config(c *gin.Context) {
	snapshot := h.settings.Snapshot()
	response.OK(c, siteConfig{
		SiteName:            snapshot.SiteName(),
		LogoURL:             snapshot.String("site.logo"),
		Description:         snapshot.String("site.description"),
		ICP:                 snapshot.String("site.icp"),
		RegistrationEnabled: snapshot.RegistrationEnabled(),
		PasswordMinLength:   snapshot.PasswordMinLength(),
		ImportEnabled:       snapshot.Bool("feature.import_enabled"),
		ExportEnabled:       snapshot.Bool("feature.export_enabled"),
		UserTemplateEnabled: snapshot.Bool("feature.user_template_enabled"),
		ShareEnabled:        snapshot.Bool("share.public_link_enabled"),
		Version:             h.version,
	})
}
