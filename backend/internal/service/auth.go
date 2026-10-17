package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
)

// 账号格式约束。用户名允许字母、数字、下划线与短横线：它要出现在 URL 与
// 提及里，允许空格或 emoji 会让后续每个使用点都要转义。
var (
	usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,32}$`)
	emailPattern    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

// SessionMeta 描述一次登录的来源，用于「登录设备」列表与审计。
type SessionMeta struct {
	Platform string
	Device   string
}

// AuthResult 是注册 / 登录 / 刷新的统一产物。
//
// RefreshToken 是明文，只在签发这一刻存在；调用方必须立刻写进 Cookie
// 或返回给客户端，不得落库、不得写日志。
type AuthResult struct {
	User             *domain.User
	AccessToken      string
	ExpiresIn        int
	RefreshToken     string
	RefreshExpiresAt time.Time
}

// RegisterInput 是注册入参。
type RegisterInput struct {
	Username string
	Email    string
	Password string
	Nickname string
	Meta     SessionMeta
}

// LoginInput 是登录入参。Identifier 同时接受邮箱与用户名。
type LoginInput struct {
	Identifier string
	Password   string
	Meta       SessionMeta
}

// AuthServiceConfig 是 AuthService 的依赖与策略。
type AuthServiceConfig struct {
	Issuer     *auth.TokenIssuer
	RefreshTTL time.Duration
	Site       SiteConfigProvider
	// UserCacheTTL 是 RequireAuth 用户状态的缓存时长。0 表示不缓存。
	// 禁用账号时由管理端调用 InvalidateUser 主动失效，所以缓存不会让
	// 「禁用」延迟生效。
	UserCacheTTL time.Duration
	// Now 为空时使用 time.Now；测试可注入固定时钟。
	Now Clock
}

// AuthService 实现认证闭环：注册、登录、刷新、登出、改密、当前用户。
//
// 它不关心 HTTP：Cookie 怎么发、状态码是多少，都是 handler 的事。
type AuthService struct {
	users      domain.UserRepo
	tokens     domain.RefreshTokenRepo
	tx         domain.TxManager
	issuer     *auth.TokenIssuer
	refreshTTL time.Duration
	site       SiteConfigProvider
	now        Clock

	cacheTTL time.Duration
	mu       sync.RWMutex
	cache    map[string]cachedUser
}

// cachedUser 是「已认证用户」的短期缓存。
//
// 缓存的是用户对象而不是令牌：同一个用户的多设备、多请求共用一份，
// 而 JWT 校验本身很便宜，没必要缓存。
type cachedUser struct {
	user      *domain.User
	expiresAt time.Time
}

// maxCachedUsers 是缓存条目上限。超过后在写入时清理过期项，
// 避免一个长期运行的实例把每个登录过的用户都留在内存里。
const maxCachedUsers = 4096

// NewAuthService 构造认证服务。
func NewAuthService(users domain.UserRepo, tokens domain.RefreshTokenRepo, tx domain.TxManager, cfg AuthServiceConfig) (*AuthService, error) {
	if users == nil || tokens == nil || tx == nil {
		return nil, errors.New("AuthService 需要用户、令牌仓储与事务管理器")
	}
	if cfg.Issuer == nil {
		return nil, errors.New("AuthService 需要 TokenIssuer")
	}
	if cfg.Site == nil {
		cfg.Site = OpenSiteConfig()
	}
	if cfg.RefreshTTL <= 0 {
		cfg.RefreshTTL = 7 * 24 * time.Hour
	}
	if cfg.UserCacheTTL < 0 {
		cfg.UserCacheTTL = 0
	}
	if cfg.Now == nil {
		cfg.Now = SystemClock
	}
	return &AuthService{
		users: users, tokens: tokens, tx: tx,
		issuer: cfg.Issuer, refreshTTL: cfg.RefreshTTL, site: cfg.Site, now: cfg.Now,
		cacheTTL: cfg.UserCacheTTL, cache: make(map[string]cachedUser),
	}, nil
}

// Register 创建账号并直接签发会话。
//
// 一期注册即生效（status = active），不涉及邮箱验证——邮件能力在二期，
// 见 ADR-012。若将来启用验证，这里是唯一需要改的分支点。
func (s *AuthService) Register(ctx context.Context, in RegisterInput) (*AuthResult, error) {
	if !s.site.RegistrationEnabled() {
		return nil, apperr.New(apperr.CodeRegistrationClosed, "")
	}

	username := strings.TrimSpace(in.Username)
	email := strings.ToLower(strings.TrimSpace(in.Email))
	nickname := strings.TrimSpace(in.Nickname)

	if fields := validateRegistration(username, email, in.Password, nickname, s.site.PasswordMinLength()); len(fields) > 0 {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(fields)
	}

	// 先查再建只是为了给出准确的错误码（邮箱 vs 用户名）。真正的唯一性
	// 仍由数据库约束保证：两次请求并发穿过这里时，Create 会返回 ErrDuplicate。
	if err := s.ensureAvailable(ctx, email, username); err != nil {
		return nil, err
	}

	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	now := s.now()
	user, err := s.users.Create(ctx, domain.CreateUserInput{
		UID: id.New(), Username: username, Email: email, PasswordHash: hash,
		Nickname: nickname, Role: domain.RoleUser, Status: domain.UserStatusActive, Now: now,
	})
	if err != nil {
		if errors.Is(err, domain.ErrDuplicate) {
			return nil, s.duplicateError(ctx, email, username)
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	return s.issueSession(ctx, user, in.Meta)
}

// Login 校验凭据并签发会话。
//
// 失败一律返回 AUTH_INVALID_CREDENTIALS：区分「用户不存在」与「密码错误」
// 等于免费提供账号枚举接口。
func (s *AuthService) Login(ctx context.Context, in LoginInput) (*AuthResult, error) {
	identifier := strings.TrimSpace(in.Identifier)
	if identifier == "" || in.Password == "" {
		return nil, apperr.New(apperr.CodeAuthInvalidCredentials, "")
	}

	var (
		user *domain.User
		err  error
	)
	if strings.Contains(identifier, "@") {
		user, err = s.users.GetByEmail(ctx, identifier)
	} else {
		user, err = s.users.GetByUsername(ctx, identifier)
	}
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			// 等时比较：账号不存在时也跑一次 bcrypt，否则「不存在」会比
			// 「密码错误」快一个数量级，用响应时间就能枚举账号。
			auth.VerifyPassword(decoyPasswordHash(), in.Password)
			return nil, apperr.New(apperr.CodeAuthInvalidCredentials, "")
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	// 先验密码再查状态：否则拿别人的邮箱随便试一个密码，就能从
	// 「403 账号已禁用」得知该账号存在且被禁用。
	if !auth.VerifyPassword(user.PasswordHash, in.Password) {
		return nil, apperr.New(apperr.CodeAuthInvalidCredentials, "")
	}
	if !user.IsActive() {
		return nil, apperr.New(apperr.CodeAuthAccountDisabled, "")
	}

	loginAt := s.now()
	if err := s.users.TouchLastLogin(ctx, user.ID, loginAt); err == nil {
		// 仓储返回的是副本，响应里要带上本次登录时间，否则前端拿到的
		// lastLoginAt 永远是上一次的值。
		user.LastLoginAt = &loginAt
	}
	return s.issueSession(ctx, user, in.Meta)
}

// Refresh 用刷新令牌换取新的 Access Token，并轮换刷新令牌。
//
// 已撤销的令牌再次出现视为泄露信号：撤销该用户全部会话，让真正的用户
// 重新登录，而不是让攻击者继续持有有效会话。
func (s *AuthService) Refresh(ctx context.Context, plainToken string, meta SessionMeta) (*AuthResult, error) {
	if plainToken == "" {
		return nil, apperr.New(apperr.CodeAuthRefreshInvalid, "")
	}
	now := s.now()
	hash := auth.HashRefreshToken(plainToken)

	stored, err := s.tokens.GetByHash(ctx, hash)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, apperr.New(apperr.CodeAuthRefreshInvalid, "")
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	if stored.Revoked() {
		// 复用检测。这里刻意不返回更具体的错误：对客户端来说结果都是
		// 「请重新登录」，而攻击者也不该知道自己的令牌已被标记。
		if _, revokeErr := s.tokens.RevokeAllForUser(ctx, stored.UserID, now); revokeErr != nil {
			return nil, apperr.Wrap(apperr.CodeInternalError, revokeErr)
		}
		return nil, apperr.New(apperr.CodeAuthRefreshInvalid, "")
	}
	if stored.Expired(now) {
		return nil, apperr.New(apperr.CodeAuthRefreshInvalid, "")
	}

	user, err := s.users.GetByID(ctx, stored.UserID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, apperr.New(apperr.CodeAuthRefreshInvalid, "")
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	if !user.IsActive() {
		return nil, apperr.New(apperr.CodeAuthAccountDisabled, "")
	}

	var result *AuthResult
	err = s.tx.WithTx(ctx, func(ctx context.Context) error {
		// 撤销与签发必须在同一事务里：否则「旧的已撤销、新的没写成」
		// 会把用户直接踢下线。
		revoked, revokeErr := s.tokens.Revoke(ctx, hash, now)
		if revokeErr != nil {
			return apperr.Wrap(apperr.CodeInternalError, revokeErr)
		}
		if !revoked {
			// 并发刷新：另一个请求已经轮换掉了这个令牌。前端必须把并发
			// 刷新合并成一次（docs/08 验收标准 5）。
			return apperr.New(apperr.CodeAuthRefreshInvalid, "")
		}
		issued, issueErr := s.issueSession(ctx, user, meta)
		if issueErr != nil {
			return issueErr
		}
		result = issued
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// Logout 撤销当前刷新令牌。幂等：令牌无效或已撤销都返回 nil。
func (s *AuthService) Logout(ctx context.Context, plainToken string) error {
	if plainToken == "" {
		return nil
	}
	if _, err := s.tokens.Revoke(ctx, auth.HashRefreshToken(plainToken), s.now()); err != nil {
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	return nil
}

// ChangePassword 修改密码，并撤销除当前设备外的全部会话。
func (s *AuthService) ChangePassword(ctx context.Context, uid, oldPassword, newPassword, currentRefreshToken string) error {
	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return apperr.New(apperr.CodeAuthTokenInvalid, "")
		}
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	if !auth.VerifyPassword(user.PasswordHash, oldPassword) {
		return apperr.New(apperr.CodeAuthInvalidCredentials, "").WithFieldErrors(map[string]string{
			"oldPassword": "当前密码不正确",
		})
	}
	if oldPassword == newPassword {
		return apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"newPassword": "新密码不能与当前密码相同",
		})
	}
	if err := auth.ValidatePassword(newPassword, s.site.PasswordMinLength()); err != nil {
		return passwordPolicyError(err)
	}

	hash, err := auth.HashPassword(newPassword)
	if err != nil {
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	now := s.now()
	if err := s.users.UpdatePassword(ctx, user.ID, hash, now); err != nil {
		return apperr.Wrap(apperr.CodeInternalError, err)
	}

	// 改密后让其它设备下线，但保留当前设备——否则用户改完密码就被自己踢出去。
	if currentRefreshToken != "" {
		if _, err := s.tokens.RevokeAllExcept(ctx, user.ID, auth.HashRefreshToken(currentRefreshToken), now); err != nil {
			return apperr.Wrap(apperr.CodeInternalError, err)
		}
		return nil
	}
	if _, err := s.tokens.RevokeAllForUser(ctx, user.ID, now); err != nil {
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	return nil
}

// Me 返回当前用户。
func (s *AuthService) Me(ctx context.Context, uid string) (*domain.User, error) {
	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	return user, nil
}

// Authenticate 校验 Access Token 并返回对应用户。供 RequireAuth 使用。
//
// 用户状态每次从数据库读（外层有 60 秒缓存）：JWT 里不带 status，
// 否则「禁用账号」要等令牌过期才生效。
func (s *AuthService) Authenticate(ctx context.Context, accessToken string) (*domain.User, error) {
	if accessToken == "" {
		return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
	}
	claims, err := s.issuer.Parse(accessToken)
	if err != nil {
		if errors.Is(err, auth.ErrTokenExpired) {
			return nil, apperr.New(apperr.CodeAuthTokenExpired, "")
		}
		return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
	}

	if cached, ok := s.cachedUser(claims.Subject); ok {
		if !cached.IsActive() {
			return nil, apperr.New(apperr.CodeAuthAccountDisabled, "")
		}
		return cached, nil
	}

	user, err := s.users.GetByUID(ctx, claims.Subject)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			// 用户被删除后，旧令牌立即失效。
			return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	if !user.IsActive() {
		return nil, apperr.New(apperr.CodeAuthAccountDisabled, "")
	}
	s.cacheUser(user)
	return user, nil
}

// InvalidateUser 让某用户的认证缓存立即失效。
//
// 禁用、删除、改角色之后必须调用：JWT 里不带状态，缓存是「禁用即时生效」
// 唯一可能被拖慢的地方。
func (s *AuthService) InvalidateUser(uid string) {
	if s.cacheTTL <= 0 || uid == "" {
		return
	}
	s.mu.Lock()
	delete(s.cache, uid)
	s.mu.Unlock()
}

func (s *AuthService) cachedUser(uid string) (*domain.User, bool) {
	if s.cacheTTL <= 0 {
		return nil, false
	}
	s.mu.RLock()
	entry, ok := s.cache[uid]
	s.mu.RUnlock()
	if !ok || !s.now().Before(entry.expiresAt) {
		return nil, false
	}
	// 返回副本：调用方可能把用户对象挂到请求上下文里，共享指针会让
	// 一次意外的字段赋值污染所有并发请求。
	copied := *entry.user
	return &copied, true
}

func (s *AuthService) cacheUser(user *domain.User) {
	if s.cacheTTL <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.cache) >= maxCachedUsers {
		now := s.now()
		for key, entry := range s.cache {
			if !now.Before(entry.expiresAt) {
				delete(s.cache, key)
			}
		}
	}
	copied := *user
	s.cache[user.UID] = cachedUser{user: &copied, expiresAt: s.now().Add(s.cacheTTL)}
}

// SeedAdmin 在用户表为空时创建首个管理员。
//
// 只在 Count()==0 时执行：一旦有人用过这个实例，配置里的种子密码就失去
// 作用，避免「部署后忘记删环境变量 = 永远有一个已知密码的管理员」。
func (s *AuthService) SeedAdmin(ctx context.Context, email, password string) (bool, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || password == "" {
		return false, nil
	}
	count, err := s.users.Count(ctx)
	if err != nil {
		return false, apperr.Wrap(apperr.CodeInternalError, err)
	}
	if count > 0 {
		return false, nil
	}
	if !emailPattern.MatchString(email) {
		return false, fmt.Errorf("种子管理员邮箱格式不正确: %q", email)
	}
	if err := auth.ValidatePassword(password, s.site.PasswordMinLength()); err != nil {
		return false, fmt.Errorf("种子管理员密码不符合策略: %w", err)
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return false, err
	}
	now := s.now()
	if _, err := s.users.Create(ctx, domain.CreateUserInput{
		UID: id.New(), Username: "admin", Email: email, PasswordHash: hash,
		Nickname: "管理员", Role: domain.RoleAdmin, Status: domain.UserStatusActive, Now: now,
	}); err != nil {
		return false, err
	}
	return true, nil
}

func (s *AuthService) issueSession(ctx context.Context, user *domain.User, meta SessionMeta) (*AuthResult, error) {
	accessToken, expiresIn, err := s.issuer.Issue(user.UID, string(user.Role))
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	plain, hash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	now := s.now()
	expiresAt := now.Add(s.refreshTTL)
	platform := strings.TrimSpace(meta.Platform)
	if platform == "" {
		platform = "web"
	}
	if _, err := s.tokens.Create(ctx, domain.CreateRefreshTokenInput{
		UserID: user.ID, TokenHash: hash, Platform: platform,
		Device:    truncateRunes(strings.TrimSpace(meta.Device), 200),
		ExpiresAt: expiresAt, Now: now,
	}); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	return &AuthResult{
		User: user, AccessToken: accessToken, ExpiresIn: expiresIn,
		RefreshToken: plain, RefreshExpiresAt: expiresAt,
	}, nil
}

func (s *AuthService) ensureAvailable(ctx context.Context, email, username string) error {
	if _, err := s.users.GetByEmail(ctx, email); err == nil {
		return apperr.New(apperr.CodeAuthEmailTaken, "")
	} else if !errors.Is(err, domain.ErrNotFound) {
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	if _, err := s.users.GetByUsername(ctx, username); err == nil {
		return apperr.New(apperr.CodeAuthUsernameTaken, "")
	} else if !errors.Is(err, domain.ErrNotFound) {
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	return nil
}

// duplicateError 在并发注册撞上唯一约束后，重新查一次以确定是哪个字段冲突。
func (s *AuthService) duplicateError(ctx context.Context, email, username string) error {
	if _, err := s.users.GetByEmail(ctx, email); err == nil {
		return apperr.New(apperr.CodeAuthEmailTaken, "")
	}
	if _, err := s.users.GetByUsername(ctx, username); err == nil {
		return apperr.New(apperr.CodeAuthUsernameTaken, "")
	}
	return apperr.New(apperr.CodeValidationFailed, "账号信息已被占用")
}

func validateRegistration(username, email, password, nickname string, minPasswordLength int) map[string]string {
	fields := make(map[string]string, 4)
	if !usernamePattern.MatchString(username) {
		fields["username"] = "用户名需为 3–32 位字母、数字、下划线或短横线"
	}
	if !emailPattern.MatchString(email) {
		fields["email"] = "邮箱格式不正确"
	}
	if len([]rune(nickname)) > 32 {
		fields["nickname"] = "昵称最多 32 个字符"
	}
	if err := auth.ValidatePassword(password, minPasswordLength); err != nil {
		fields["password"] = passwordPolicyMessage(err, minPasswordLength)
	}
	return fields
}

func passwordPolicyError(err error) *apperr.Error {
	return apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
		"password": passwordPolicyMessage(err, 0),
	})
}

func passwordPolicyMessage(err error, minLength int) string {
	if minLength <= 0 {
		minLength = auth.DefaultMinPasswordLength
	}
	switch {
	case errors.Is(err, auth.ErrPasswordTooShort):
		return fmt.Sprintf("密码至少需要 %d 个字符", minLength)
	case errors.Is(err, auth.ErrPasswordTooLong):
		return fmt.Sprintf("密码最多 %d 字节", auth.MaxPasswordBytes)
	case errors.Is(err, auth.ErrPasswordTooWeak):
		return "这个密码太常见，请换一个"
	default:
		return "密码不符合要求"
	}
}

func truncateRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit])
}

// decoyPasswordHash 返回一个固定哈希，用于账号不存在时的等时比较。
//
// 延迟到第一次失败登录才计算：bcrypt cost 12 约 250ms，放在启动路径上
// 会白白拖慢每次冷启动。
var decoyPasswordHash = sync.OnceValue(func() string {
	hash, err := auth.HashPassword("decoy-password-for-timing-equalization")
	if err != nil {
		return ""
	}
	return hash
})
