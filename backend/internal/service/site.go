// Package service 实现业务规则。它只依赖 domain 中的接口，不依赖任何具体
// 数据库方言（由 cmd/dialectcheck 静态检查兜底）。
package service

import (
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

// SiteConfigProvider 暴露站点级配置。认证流程需要其中三项：
// 是否开放注册、密码最小长度、新用户默认角色。
//
// 定义成接口而不是直接读 settings 仓储，是因为这几个值在认证路径上是热数据
// （每次注册都要读），实现方可以换成内存快照而不影响调用方。
type SiteConfigProvider interface {
	RegistrationEnabled() bool
	PasswordMinLength() int
	DefaultRole() string
}

// StaticSiteConfig 是一份固定配置，用于测试与「设置服务尚未接入」的场合。
//
// M1-4 接入 settings 表后，生产装配会换成快照实现；本类型仍然保留，
// 因为大量 service 测试只关心「注册开/关」这一个变量。
type StaticSiteConfig struct {
	RegistrationOn    bool
	MinPasswordLength int
	// Role 是新用户默认角色，空值视为 user。
	Role string
}

// RegistrationEnabled 报告是否开放注册。
func (c StaticSiteConfig) RegistrationEnabled() bool { return c.RegistrationOn }

// PasswordMinLength 返回密码最小长度（字符数）。
func (c StaticSiteConfig) PasswordMinLength() int {
	if c.MinPasswordLength <= 0 {
		return 8
	}
	return c.MinPasswordLength
}

// DefaultRole 返回新用户默认角色。
func (c StaticSiteConfig) DefaultRole() string {
	if c.Role == "" {
		return string(domain.RoleUser)
	}
	return c.Role
}

// OpenSiteConfig 是「默认站点」：开放注册、密码至少 8 位。
func OpenSiteConfig() StaticSiteConfig {
	return StaticSiteConfig{RegistrationOn: true, MinPasswordLength: 8}
}

// Clock 抽象「现在」，让测试不必 sleep。
type Clock func() time.Time

// SystemClock 是生产用的时钟。
func SystemClock() time.Time { return time.Now() }
