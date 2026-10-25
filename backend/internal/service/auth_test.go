package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

type authFixture struct {
	svc    *AuthService
	users  *fakeUserRepo
	tokens *fakeTokenRepo
	now    *time.Time
}

func newAuthFixture(t *testing.T, site SiteConfigProvider) *authFixture {
	t.Helper()
	now := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }

	issuer, err := auth.NewTokenIssuer("unit-test-secret-that-is-long-enough", 15*time.Minute)
	if err != nil {
		t.Fatalf("NewTokenIssuer: %v", err)
	}
	// 签发与校验必须用同一只时钟，否则「把时间拨快 16 分钟」只影响服务层，
	// 令牌仍然按真实时间判断未过期。
	issuer.SetClock(clock)

	users := newFakeUserRepo()
	tokens := newFakeTokenRepo()
	if site == nil {
		site = OpenSiteConfig()
	}
	svc, err := NewAuthService(users, tokens, fakeTxManager{}, AuthServiceConfig{
		Issuer: issuer, RefreshTTL: 7 * 24 * time.Hour, Site: site, Now: clock,
		TwoFactor: &authTestSecurityRepo{states: map[int64]domain.TwoFactorState{}}, TwoFactorKey: "unit-test-two-factor-key-long-enough",
	})
	if err != nil {
		t.Fatalf("NewAuthService: %v", err)
	}
	return &authFixture{svc: svc, users: users, tokens: tokens, now: &now}
}

type authTestSecurityRepo struct {
	states map[int64]domain.TwoFactorState
}

func (r *authTestSecurityRepo) Ensure(context.Context, int64) error { return nil }
func (r *authTestSecurityRepo) Get(_ context.Context, id int64, _ bool) (*domain.TwoFactorState, error) {
	state := r.states[id]
	return &state, nil
}
func (r *authTestSecurityRepo) Save(_ context.Context, id int64, state *domain.TwoFactorState) error {
	r.states[id] = *state
	return nil
}

func requireCode(t *testing.T, err error, want apperr.Code) *apperr.Error {
	t.Helper()
	var appErr *apperr.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("错误 = %v; 期望应用错误 %s", err, want)
	}
	if appErr.Code != want {
		t.Fatalf("错误码 = %s (%s); 期望 %s", appErr.Code, appErr.Message, want)
	}
	return appErr
}

func registerAlice(t *testing.T, f *authFixture) *AuthResult {
	t.Helper()
	result, err := f.svc.Register(context.Background(), RegisterInput{
		Username: "alice", Email: "Alice@Example.com", Password: "correct-horse",
		Nickname: "Alice", Meta: SessionMeta{Platform: "web", Device: "go-test"},
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return result
}

func TestRegisterCreatesActiveUserAndSession(t *testing.T) {
	f := newAuthFixture(t, nil)
	result := registerAlice(t, f)

	if result.User.Status != domain.UserStatusActive || result.User.Role != domain.RoleUser {
		t.Fatalf("新用户 = %#v; 期望 active/user", result.User)
	}
	if result.User.Email != "alice@example.com" {
		t.Fatalf("邮箱未归一化为小写: %q", result.User.Email)
	}
	if result.AccessToken == "" || result.RefreshToken == "" || result.ExpiresIn != 900 {
		t.Fatalf("会话不完整: %#v", result)
	}
	// 明文刷新令牌绝不能落库。
	stored, err := f.tokens.GetByHash(context.Background(), auth.HashRefreshToken(result.RefreshToken))
	if err != nil || stored.UserID != result.User.ID {
		t.Fatalf("刷新令牌未按哈希入库: %#v, %v", stored, err)
	}
	if stored.TokenHash == result.RefreshToken {
		t.Fatal("库里存了明文刷新令牌")
	}
}

func TestRegisterRejectsClosedSite(t *testing.T) {
	f := newAuthFixture(t, StaticSiteConfig{RegistrationOn: false})
	_, err := f.svc.Register(context.Background(), RegisterInput{
		Username: "bob", Email: "bob@example.com", Password: "correct-horse",
	})
	requireCode(t, err, apperr.CodeRegistrationClosed)
}

func TestRegisterValidation(t *testing.T) {
	f := newAuthFixture(t, nil)
	cases := []struct {
		name  string
		input RegisterInput
		field string
	}{
		{"用户名太短", RegisterInput{Username: "ab", Email: "a@b.co", Password: "correct-horse"}, "username"},
		{"用户名含空格", RegisterInput{Username: "a b", Email: "a@b.co", Password: "correct-horse"}, "username"},
		{"邮箱格式错误", RegisterInput{Username: "alice", Email: "not-an-email", Password: "correct-horse"}, "email"},
		{"密码太短", RegisterInput{Username: "alice", Email: "a@b.co", Password: "short"}, "password"},
		{"密码太常见", RegisterInput{Username: "alice", Email: "a@b.co", Password: "password123"}, "password"},
		{"昵称过长", RegisterInput{Username: "alice", Email: "a@b.co", Password: "correct-horse", Nickname: string(make([]rune, 33))}, "nickname"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.svc.Register(context.Background(), tc.input)
			appErr := requireCode(t, err, apperr.CodeValidationFailed)
			fields, _ := appErr.Details["fields"].(map[string]string)
			if fields[tc.field] == "" {
				t.Fatalf("错误细节缺少字段 %q: %#v", tc.field, appErr.Details)
			}
		})
	}
}

func TestRegisterRejectsDuplicateIdentity(t *testing.T) {
	f := newAuthFixture(t, nil)
	registerAlice(t, f)

	_, err := f.svc.Register(context.Background(), RegisterInput{
		Username: "alice2", Email: "ALICE@example.com", Password: "correct-horse",
	})
	requireCode(t, err, apperr.CodeAuthEmailTaken)

	_, err = f.svc.Register(context.Background(), RegisterInput{
		Username: "Alice", Email: "other@example.com", Password: "correct-horse",
	})
	requireCode(t, err, apperr.CodeAuthUsernameTaken)
}

func TestLogin(t *testing.T) {
	f := newAuthFixture(t, nil)
	registerAlice(t, f)

	result, err := f.svc.Login(context.Background(), LoginInput{Identifier: "alice", Password: "correct-horse"})
	if err != nil || result.User.Username != "alice" {
		t.Fatalf("按用户名登录 = %#v, %v", result, err)
	}
	if result.User.LastLoginAt == nil {
		t.Fatal("登录成功后应记录 last_login_at")
	}

	if _, err := f.svc.Login(context.Background(), LoginInput{Identifier: "ALICE@example.com", Password: "correct-horse"}); err != nil {
		t.Fatalf("按邮箱登录（大小写不敏感）: %v", err)
	}

	// 密码错误与账号不存在必须返回同一个错误码。
	_, wrongPassword := f.svc.Login(context.Background(), LoginInput{Identifier: "alice", Password: "wrong-password"})
	requireCode(t, wrongPassword, apperr.CodeAuthInvalidCredentials)
	_, missingUser := f.svc.Login(context.Background(), LoginInput{Identifier: "nobody", Password: "wrong-password"})
	requireCode(t, missingUser, apperr.CodeAuthInvalidCredentials)
}

func TestLoginRejectsDisabledAccount(t *testing.T) {
	f := newAuthFixture(t, nil)
	result := registerAlice(t, f)

	f.users.mu.Lock()
	f.users.byID[result.User.ID].Status = domain.UserStatusDisabled
	f.users.mu.Unlock()

	// 密码正确但账号禁用 → 403 语义的错误码。
	_, err := f.svc.Login(context.Background(), LoginInput{Identifier: "alice", Password: "correct-horse"})
	requireCode(t, err, apperr.CodeAuthAccountDisabled)

	// 密码错误时不能泄露「账号存在但被禁用」。
	_, err = f.svc.Login(context.Background(), LoginInput{Identifier: "alice", Password: "wrong-password"})
	requireCode(t, err, apperr.CodeAuthInvalidCredentials)
}

func TestRefreshRotatesToken(t *testing.T) {
	f := newAuthFixture(t, nil)
	first := registerAlice(t, f)

	second, err := f.svc.Refresh(context.Background(), first.RefreshToken, SessionMeta{})
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if second.RefreshToken == first.RefreshToken || second.AccessToken == "" {
		t.Fatalf("刷新后令牌未轮换: %#v", second)
	}

	// 旧令牌已被撤销。再次使用会命中「复用检测」，连带撤销该用户全部会话，
	// 所以刚拿到的新令牌也会失效——这是有意的严格策略。
	_, err = f.svc.Refresh(context.Background(), first.RefreshToken, SessionMeta{})
	requireCode(t, err, apperr.CodeAuthRefreshInvalid)

	if active := f.tokens.activeTokens(first.User.ID); len(active) != 0 {
		t.Fatalf("复用检测后仍有 %d 个可用会话", len(active))
	}
	_, err = f.svc.Refresh(context.Background(), second.RefreshToken, SessionMeta{})
	requireCode(t, err, apperr.CodeAuthRefreshInvalid)
}

func TestRefreshRejectsExpiredAndUnknown(t *testing.T) {
	f := newAuthFixture(t, nil)
	first := registerAlice(t, f)

	*f.now = f.now.Add(8 * 24 * time.Hour)
	_, err := f.svc.Refresh(context.Background(), first.RefreshToken, SessionMeta{})
	requireCode(t, err, apperr.CodeAuthRefreshInvalid)

	_, err = f.svc.Refresh(context.Background(), "never-issued", SessionMeta{})
	requireCode(t, err, apperr.CodeAuthRefreshInvalid)

	_, err = f.svc.Refresh(context.Background(), "", SessionMeta{})
	requireCode(t, err, apperr.CodeAuthRefreshInvalid)
}

func TestLogoutIsIdempotent(t *testing.T) {
	f := newAuthFixture(t, nil)
	result := registerAlice(t, f)

	if err := f.svc.Logout(context.Background(), result.RefreshToken); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if err := f.svc.Logout(context.Background(), result.RefreshToken); err != nil {
		t.Fatalf("重复 Logout 应成功: %v", err)
	}
	if err := f.svc.Logout(context.Background(), ""); err != nil {
		t.Fatalf("空令牌 Logout 应成功: %v", err)
	}
	if _, err := f.svc.Refresh(context.Background(), result.RefreshToken, SessionMeta{}); err == nil {
		t.Fatal("登出后刷新应失败")
	}
}

func TestChangePasswordRevokesOtherSessions(t *testing.T) {
	f := newAuthFixture(t, nil)
	first := registerAlice(t, f)

	// 第二个设备登录，得到一个独立的刷新令牌。
	second, err := f.svc.Login(context.Background(), LoginInput{Identifier: "alice", Password: "correct-horse"})
	if err != nil {
		t.Fatalf("第二次登录: %v", err)
	}

	if _, err := f.svc.ChangePassword(context.Background(), first.User.UID, "correct-horse", "brand-new-secret", SessionMeta{}); err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}

	// 当前设备保留，其它设备下线。
	if active := f.tokens.activeTokens(first.User.ID); len(active) != 1 {
		t.Fatalf("改密后可用会话 = %d; 期望 1（当前设备）", len(active))
	}
	if _, err := f.svc.Refresh(context.Background(), second.RefreshToken, SessionMeta{}); err == nil {
		t.Fatal("其它设备的会话应被撤销")
	}

	if _, err := f.svc.Login(context.Background(), LoginInput{Identifier: "alice", Password: "correct-horse"}); err == nil {
		t.Fatal("旧密码仍可登录")
	}
	if _, err := f.svc.Login(context.Background(), LoginInput{Identifier: "alice", Password: "brand-new-secret"}); err != nil {
		t.Fatalf("新密码登录失败: %v", err)
	}
}

func TestChangePasswordValidation(t *testing.T) {
	f := newAuthFixture(t, nil)
	result := registerAlice(t, f)
	ctx := context.Background()

	_, wrongOld := f.svc.ChangePassword(ctx, result.User.UID, "nope", "brand-new-secret", SessionMeta{})
	requireCode(t, wrongOld, apperr.CodeAuthInvalidCredentials)

	_, same := f.svc.ChangePassword(ctx, result.User.UID, "correct-horse", "correct-horse", SessionMeta{})
	requireCode(t, same, apperr.CodeValidationFailed)

	_, weak := f.svc.ChangePassword(ctx, result.User.UID, "correct-horse", "password123", SessionMeta{})
	requireCode(t, weak, apperr.CodeValidationFailed)
}

func TestAuthenticate(t *testing.T) {
	f := newAuthFixture(t, nil)
	result := registerAlice(t, f)
	ctx := context.Background()

	user, err := f.svc.Authenticate(ctx, result.AccessToken)
	if err != nil || user.UID != result.User.UID {
		t.Fatalf("Authenticate = %#v, %v", user, err)
	}

	*f.now = f.now.Add(16 * time.Minute)
	_, err = f.svc.Authenticate(ctx, result.AccessToken)
	requireCode(t, err, apperr.CodeAuthTokenExpired)

	*f.now = f.now.Add(-16 * time.Minute)
	f.users.mu.Lock()
	f.users.byID[result.User.ID].Status = domain.UserStatusDisabled
	f.users.mu.Unlock()
	_, err = f.svc.Authenticate(ctx, result.AccessToken)
	requireCode(t, err, apperr.CodeAuthAccountDisabled)

	_, err = f.svc.Authenticate(ctx, "garbage")
	requireCode(t, err, apperr.CodeAuthTokenInvalid)
}

func TestSeedAdmin(t *testing.T) {
	f := newAuthFixture(t, nil)
	ctx := context.Background()

	created, err := f.svc.SeedAdmin(ctx, "Admin@Example.com", "seeded-admin-password")
	if err != nil || !created {
		t.Fatalf("SeedAdmin = %v, %v; 期望创建", created, err)
	}
	user, err := f.users.GetByEmail(ctx, "admin@example.com")
	if err != nil || user.Role != domain.RoleAdmin {
		t.Fatalf("种子管理员 = %#v, %v", user, err)
	}

	// 用户表非空后不再种第二个管理员。
	created, err = f.svc.SeedAdmin(ctx, "second@example.com", "another-admin-password")
	if err != nil || created {
		t.Fatalf("第二次 SeedAdmin = %v, %v; 期望跳过", created, err)
	}

	// 空配置直接跳过，不算错误。
	empty := newAuthFixture(t, nil)
	if created, err := empty.svc.SeedAdmin(ctx, "", ""); err != nil || created {
		t.Fatalf("空配置 SeedAdmin = %v, %v", created, err)
	}
}

func TestSeedAdminRejectsWeakPassword(t *testing.T) {
	f := newAuthFixture(t, nil)
	if _, err := f.svc.SeedAdmin(context.Background(), "admin@example.com", "password123"); err == nil {
		t.Fatal("弱密码应被拒绝")
	}
}

func TestLoginLockoutAfterRepeatedFailures(t *testing.T) {
	f := newAuthFixture(t, nil)
	registerAlice(t, f)
	ctx := context.Background()
	attacker := LoginInput{Identifier: "alice", Password: "wrong-password", ClientIP: "203.0.113.9"}

	for i := 1; i <= 4; i++ {
		_, err := f.svc.Login(ctx, attacker)
		requireCode(t, err, apperr.CodeAuthInvalidCredentials)
	}

	// 第 5 次失败触发锁定，返回 429 而不是 401。
	_, err := f.svc.Login(ctx, attacker)
	requireCode(t, err, apperr.CodeAuthTooManyAttempts)

	// 锁定期内即使密码正确也拒绝：否则「锁定」只是延迟了爆破。
	_, err = f.svc.Login(ctx, LoginInput{Identifier: "alice", Password: "correct-horse", ClientIP: "203.0.113.9"})
	requireCode(t, err, apperr.CodeAuthTooManyAttempts)

	// 换个 IP 不受影响（锁定维度是 IP + 账号）。
	if _, err := f.svc.Login(ctx, LoginInput{Identifier: "alice", Password: "correct-horse", ClientIP: "203.0.113.10"}); err != nil {
		t.Fatalf("其它 IP 登录失败: %v", err)
	}

	// 锁定到期后恢复。
	*f.now = f.now.Add(15*time.Minute + time.Second)
	if _, err := f.svc.Login(ctx, LoginInput{Identifier: "alice", Password: "correct-horse", ClientIP: "203.0.113.9"}); err != nil {
		t.Fatalf("锁定到期后仍无法登录: %v", err)
	}
}

func TestLoginSuccessResetsFailureCount(t *testing.T) {
	f := newAuthFixture(t, nil)
	registerAlice(t, f)
	ctx := context.Background()
	key := LoginInput{Identifier: "alice", Password: "wrong-password", ClientIP: "198.51.100.7"}

	for i := 0; i < 3; i++ {
		_, _ = f.svc.Login(ctx, key)
	}
	if _, err := f.svc.Login(ctx, LoginInput{Identifier: "alice", Password: "correct-horse", ClientIP: "198.51.100.7"}); err != nil {
		t.Fatalf("成功登录: %v", err)
	}
	// 成功一次后计数清零：再来 4 次失败也不该锁定。
	for i := 0; i < 4; i++ {
		_, err := f.svc.Login(ctx, key)
		requireCode(t, err, apperr.CodeAuthInvalidCredentials)
	}
}
