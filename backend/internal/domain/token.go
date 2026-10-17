package domain

import (
	"context"
	"time"
)

// RefreshToken 是长期会话凭证（默认 7 天）。
//
// 库里只存 TokenHash（明文的 SHA-256），明文只在签发那一刻出现在响应里。
// 这样即使数据库被拖走，也不能直接拿去换 Access Token。
//
// RevokedAt 用软撤销而不是删行：轮换后旧令牌再次出现，是「令牌被复制」的
// 唯一信号，删掉行就丢了这条证据（见 docs/04 §5.2 与 ADR 笔记）。
type RefreshToken struct {
	ID        int64
	UserID    int64
	TokenHash string
	Platform  string
	Device    string
	ExpiresAt time.Time
	RevokedAt *time.Time
	CreatedAt time.Time
}

// Revoked 报告令牌是否已被撤销。
func (t *RefreshToken) Revoked() bool { return t.RevokedAt != nil }

// Expired 报告在给定时刻是否已过期。
//
// 时刻由调用方传入而不是内部调用 time.Now()：测试需要把「过期」这件事
// 从真实时间上解耦，否则只能靠 sleep。
func (t *RefreshToken) Expired(at time.Time) bool { return !at.Before(t.ExpiresAt) }

// Usable 报告令牌在给定时刻是否可用（未撤销且未过期）。
func (t *RefreshToken) Usable(at time.Time) bool { return !t.Revoked() && !t.Expired(at) }

// CreateRefreshTokenInput 是签发刷新令牌的入参。
type CreateRefreshTokenInput struct {
	UserID    int64
	TokenHash string
	Platform  string
	Device    string
	ExpiresAt time.Time
	Now       time.Time
}

// RefreshTokenRepo 是刷新令牌仓储接口。
//
// 撤销类方法返回受影响行数而不是 error：调用方需要区分「刚刚撤销」与
// 「本来就无效」，而这两种情况都不算错误。
type RefreshTokenRepo interface {
	Create(ctx context.Context, in CreateRefreshTokenInput) (*RefreshToken, error)
	GetByHash(ctx context.Context, tokenHash string) (*RefreshToken, error)

	// Revoke 撤销单个令牌，返回是否真的撤销了一行。
	Revoke(ctx context.Context, tokenHash string, at time.Time) (bool, error)
	// RevokeAllForUser 撤销该用户全部未撤销令牌（禁用账号、重置密码时用）。
	RevokeAllForUser(ctx context.Context, userID int64, at time.Time) (int64, error)
	// RevokeAllExcept 撤销除 keepTokenHash 之外的全部令牌（改密后保留当前设备）。
	RevokeAllExcept(ctx context.Context, userID int64, keepTokenHash string, at time.Time) (int64, error)
	// DeleteExpired 清理过期行，返回删除行数。由后台任务周期调用。
	DeleteExpired(ctx context.Context, before time.Time) (int64, error)
}
