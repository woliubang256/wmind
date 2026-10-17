package service

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

// fakeUserRepo 是内存版用户仓储。
//
// 只实现认证流程真正用到的方法：其余方法由内嵌的 nil 接口提供，
// 一旦被调用会立刻 panic——这比返回零值更能暴露「测试走到了预期之外的分支」。
type fakeUserRepo struct {
	domain.UserRepo

	mu     sync.Mutex
	nextID int64
	byID   map[int64]*domain.User
}

func newFakeUserRepo() *fakeUserRepo {
	return &fakeUserRepo{byID: make(map[int64]*domain.User)}
}

func (r *fakeUserRepo) clone(u *domain.User) *domain.User {
	copied := *u
	return &copied
}

func (r *fakeUserRepo) Create(_ context.Context, in domain.CreateUserInput) (*domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.byID {
		if existing.DeletedAt != nil {
			continue
		}
		if strings.EqualFold(existing.Email, in.Email) || strings.EqualFold(existing.Username, in.Username) {
			return nil, domain.ErrDuplicate
		}
	}
	r.nextID++
	user := &domain.User{
		ID: r.nextID, UID: in.UID, Username: in.Username, Email: in.Email,
		PasswordHash: in.PasswordHash, Nickname: in.Nickname, AvatarURL: in.AvatarURL,
		Role: in.Role, Status: in.Status, CreatedAt: in.Now, UpdatedAt: in.Now,
	}
	r.byID[user.ID] = user
	return r.clone(user), nil
}

func (r *fakeUserRepo) GetByID(_ context.Context, id int64) (*domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	user, ok := r.byID[id]
	if !ok || user.DeletedAt != nil {
		return nil, domain.ErrNotFound
	}
	return r.clone(user), nil
}

func (r *fakeUserRepo) GetByUID(_ context.Context, uid string) (*domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, user := range r.byID {
		if user.UID == uid && user.DeletedAt == nil {
			return r.clone(user), nil
		}
	}
	return nil, domain.ErrNotFound
}

func (r *fakeUserRepo) GetByEmail(_ context.Context, email string) (*domain.User, error) {
	return r.find(func(u *domain.User) bool { return strings.EqualFold(u.Email, email) })
}

func (r *fakeUserRepo) GetByUsername(_ context.Context, username string) (*domain.User, error) {
	return r.find(func(u *domain.User) bool { return strings.EqualFold(u.Username, username) })
}

func (r *fakeUserRepo) find(match func(*domain.User) bool) (*domain.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]int64, 0, len(r.byID))
	for id := range r.byID {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if user := r.byID[id]; user.DeletedAt == nil && match(user) {
			return r.clone(user), nil
		}
	}
	return nil, domain.ErrNotFound
}

func (r *fakeUserRepo) Count(context.Context) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for _, user := range r.byID {
		if user.DeletedAt == nil {
			n++
		}
	}
	return n, nil
}

func (r *fakeUserRepo) UpdatePassword(_ context.Context, id int64, passwordHash string, now time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	user, ok := r.byID[id]
	if !ok || user.DeletedAt != nil {
		return domain.ErrNotFound
	}
	user.PasswordHash = passwordHash
	user.UpdatedAt = now
	return nil
}

func (r *fakeUserRepo) TouchLastLogin(_ context.Context, id int64, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	user, ok := r.byID[id]
	if !ok {
		return domain.ErrNotFound
	}
	value := at
	user.LastLoginAt = &value
	return nil
}

// fakeTokenRepo 是内存版刷新令牌仓储。
type fakeTokenRepo struct {
	domain.RefreshTokenRepo

	mu     sync.Mutex
	nextID int64
	rows   []*domain.RefreshToken
}

func newFakeTokenRepo() *fakeTokenRepo { return &fakeTokenRepo{} }

func (r *fakeTokenRepo) Create(_ context.Context, in domain.CreateRefreshTokenInput) (*domain.RefreshToken, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	row := &domain.RefreshToken{
		ID: r.nextID, UserID: in.UserID, TokenHash: in.TokenHash,
		Platform: in.Platform, Device: in.Device, ExpiresAt: in.ExpiresAt, CreatedAt: in.Now,
	}
	r.rows = append(r.rows, row)
	copied := *row
	return &copied, nil
}

func (r *fakeTokenRepo) GetByHash(_ context.Context, tokenHash string) (*domain.RefreshToken, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, row := range r.rows {
		if row.TokenHash == tokenHash {
			copied := *row
			return &copied, nil
		}
	}
	return nil, domain.ErrNotFound
}

func (r *fakeTokenRepo) Revoke(_ context.Context, tokenHash string, at time.Time) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, row := range r.rows {
		if row.TokenHash == tokenHash && row.RevokedAt == nil {
			value := at
			row.RevokedAt = &value
			return true, nil
		}
	}
	return false, nil
}

func (r *fakeTokenRepo) RevokeAllForUser(_ context.Context, userID int64, at time.Time) (int64, error) {
	return r.revokeWhere(func(row *domain.RefreshToken) bool { return row.UserID == userID }, at)
}

func (r *fakeTokenRepo) RevokeAllExcept(_ context.Context, userID int64, keepTokenHash string, at time.Time) (int64, error) {
	return r.revokeWhere(func(row *domain.RefreshToken) bool {
		return row.UserID == userID && row.TokenHash != keepTokenHash
	}, at)
}

func (r *fakeTokenRepo) revokeWhere(match func(*domain.RefreshToken) bool, at time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for _, row := range r.rows {
		if row.RevokedAt == nil && match(row) {
			value := at
			row.RevokedAt = &value
			n++
		}
	}
	return n, nil
}

func (r *fakeTokenRepo) DeleteExpired(_ context.Context, before time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.rows[:0]
	var n int64
	for _, row := range r.rows {
		if row.ExpiresAt.Before(before) {
			n++
			continue
		}
		kept = append(kept, row)
	}
	r.rows = kept
	return n, nil
}

// activeTokens 返回该用户当前仍可用的令牌哈希，便于断言「会话被撤销」。
func (r *fakeTokenRepo) activeTokens(userID int64) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, row := range r.rows {
		if row.UserID == userID && row.RevokedAt == nil {
			out = append(out, row.TokenHash)
		}
	}
	return out
}

// fakeTxManager 直接执行回调：单测里没有真实事务可开。
type fakeTxManager struct{}

func (fakeTxManager) WithTx(ctx context.Context, fn func(context.Context) error) error {
	return fn(ctx)
}
