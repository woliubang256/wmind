package domain

import (
	"context"
	"net/netip"
	"strings"
	"time"
)

// NormalizeIP 校验并规范化来源 IP；空串或非法地址一律返回空串。
//
// 两套方言必须在这里对齐：SQLite 的 TEXT 列会老实存下 "not-an-ip"，
// PostgreSQL 的 INET 列则会直接报错。若只在 PostgreSQL 侧做校验，
// 同一份代码在两种数据库下会写出不同的审计内容——这正是契约测试要拦的东西。
func NormalizeIP(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil {
		return ""
	}
	return addr.String()
}

// AuditLog 是一条审计记录。
//
// 表是 append-only：仓储接口刻意不提供 Update / Delete，应用改不动自己的
// 审计轨迹。Detail 是 JSON 文本，写入前必须由 service 层剔除敏感字段
// （密码、令牌明文）。
type AuditLog struct {
	ID         int64
	ActorID    *int64
	Action     string
	TargetType string
	TargetID   string
	Detail     string
	IP         string
	CreatedAt  time.Time
	// Actor / TargetName are read-only display context derived from event snapshots.
	Actor      *AuditActor
	TargetName string
}

// AuditActor contains only identity names, never email or credentials.
type AuditActor struct {
	UID      string `json:"uid"`
	Username string `json:"username"`
	Nickname string `json:"nickname"`
}

// 审计动作名。集中定义，避免各处手写字符串导致统计口径分裂。
const (
	AuditUserCreate        = "user.create"
	AuditUserUpdate        = "user.update"
	AuditUserDisable       = "user.disable"
	AuditUserEnable        = "user.enable"
	AuditUserDelete        = "user.delete"
	AuditUserRoleChange    = "user.role"
	AuditUserPasswordReset = "user.reset_password"
	AuditSettingsUpdate    = "settings.update"
	AuditShareCreate       = "share.create"
	AuditShareRevoke       = "share.revoke"
)

// CreateAuditLogInput 是写审计记录的入参。
//
// IP 用字符串而不是 netip.Addr：domain 包不依赖任何方言或网络类型，
// 由 PostgreSQL 仓储在边界上转换。
type CreateAuditLogInput struct {
	ActorID    *int64
	Action     string
	TargetType string
	TargetID   string
	Detail     string
	IP         string
	Now        time.Time
}

// AuditFilter 是审计日志的查询条件。零值表示不筛选。
type AuditFilter struct {
	// Action 精确匹配动作名（如 user.disable）。
	Action string
	// ActorID 只保留某个操作人的记录。
	ActorID *int64
	// From / To 是时间闭区间，nil 表示该端不限。
	From *time.Time
	To   *time.Time
}

// AuditRepo 是审计日志仓储接口（只增不改）。
type AuditRepo interface {
	Create(ctx context.Context, in CreateAuditLogInput) error
	List(ctx context.Context, filter AuditFilter, page Page) ([]*AuditLog, error)
	Count(ctx context.Context, filter AuditFilter) (int64, error)
}
