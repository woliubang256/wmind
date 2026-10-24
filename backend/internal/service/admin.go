package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
)

// Actor 是执行管理操作的人。
//
// IP 单独传而不是从 ctx 里取：service 层不认识 gin，也不该认识。
type Actor struct {
	ID  *int64
	UID string
	IP  string
}

// AuditEntry 是一条待写入的审计记录。
//
// Detail 用 map 而不是 JSON 文本：序列化与「剔除敏感字段」的责任集中在
// recordAudit 一处，调用点只描述「发生了什么」。
type AuditEntry struct {
	Actor      Actor
	Action     string
	TargetType string
	TargetID   string
	Detail     map[string]any
}

// Auditor 记录敏感操作。AdminService 实现它；handler 通过接口使用，
// 这样「哪些操作要审计」在装配处一目了然。
type Auditor interface {
	Record(ctx context.Context, entry AuditEntry) error
}

// StorageUsage 提供上传文件的业务字节数。
type StorageUsage interface {
	Usage(context.Context) (int64, error)
}

// AdminServiceConfig 是 AdminService 的依赖。
type AdminServiceConfig struct {
	Stats     domain.AdminStatsRepo
	Uploads   StorageUsage
	Users     domain.UserRepo
	Tokens    domain.RefreshTokenRepo
	Audit     domain.AuditRepo
	Site      SiteConfigProvider
	TwoFactor domain.TwoFactorRepo
	Tx        domain.TxManager
	Logger    *slog.Logger
	Now       Clock
}

// AdminService 实现管理后台的业务规则。
type AdminService struct {
	stats     domain.AdminStatsRepo
	uploads   StorageUsage
	users     domain.UserRepo
	tokens    domain.RefreshTokenRepo
	audit     domain.AuditRepo
	site      SiteConfigProvider
	twoFactor domain.TwoFactorRepo
	tx        domain.TxManager
	logger    *slog.Logger
	now       Clock
}

// NewAdminService 构造管理服务。
func NewAdminService(cfg AdminServiceConfig) (*AdminService, error) {
	if cfg.Stats == nil || cfg.Uploads == nil {
		return nil, errors.New("AdminService 需要统计仓储和上传存储")
	}
	if cfg.Users == nil {
		return nil, errors.New("AdminService 需要用户仓储")
	}
	if cfg.Audit == nil {
		return nil, errors.New("AdminService 需要审计仓储")
	}
	if cfg.Tokens == nil || cfg.TwoFactor == nil || cfg.Tx == nil {
		return nil, errors.New("AdminService 需要令牌、安全状态仓储与事务管理器")
	}
	if cfg.Site == nil {
		cfg.Site = OpenSiteConfig()
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = SystemClock
	}
	return &AdminService{
		stats: cfg.Stats, uploads: cfg.Uploads,
		users: cfg.Users, tokens: cfg.Tokens, audit: cfg.Audit, site: cfg.Site,
		twoFactor: cfg.TwoFactor, tx: cfg.Tx, logger: cfg.Logger, now: cfg.Now,
	}, nil
}

// Record 写一条审计记录。
//
// 失败只记日志、不向上返回：审计写入失败不该让一次已经生效的管理操作
// 变成 500——管理员会重试，而重试会再执行一遍（重置密码尤其糟糕，
// 第二次会生成第二个密码）。
func (s *AdminService) Record(ctx context.Context, entry AuditEntry) error {
	detail := "{}"
	if len(entry.Detail) > 0 {
		encoded, err := json.Marshal(entry.Detail)
		if err != nil {
			// 序列化失败也别丢掉这条记录：记下动作本身，细节用空对象。
			s.logger.Error("审计细节序列化失败", "action", entry.Action, "err", err)
		} else {
			detail = string(encoded)
		}
	}
	err := s.audit.Create(ctx, domain.CreateAuditLogInput{
		ActorID:    entry.Actor.ID,
		Action:     entry.Action,
		TargetType: entry.TargetType,
		TargetID:   entry.TargetID,
		Detail:     detail,
		IP:         entry.Actor.IP,
		Now:        s.now(),
	})
	if err != nil {
		s.logger.Error("写审计日志失败",
			"action", entry.Action, "target", entry.TargetID, "err", err)
	}
	return err
}

// ListUsers 返回用户列表与总数。
func (s *AdminService) ListUsers(ctx context.Context, in domain.ListUsersInput) ([]*domain.User, int64, error) {
	users, err := s.users.List(ctx, in)
	if err != nil {
		return nil, 0, apperr.Wrap(apperr.CodeInternalError, err)
	}
	total, err := s.users.CountFiltered(ctx, in)
	if err != nil {
		return nil, 0, apperr.Wrap(apperr.CodeInternalError, err)
	}
	return users, total, nil
}

// CreateUserInput 是管理员创建用户的入参。
type CreateUserInput struct {
	Username string
	Email    string
	Password string
	Nickname string
	Role     domain.Role
}

// CreateUser 由管理员直接创建一个用户。
//
// 与注册的区别只有两点：不受「注册已关闭」限制、可以指定角色。其余校验
// 完全复用注册那套（用户名/邮箱格式、密码策略、弱密码黑名单）——两套规则
// 漂移会造出「管理员能建出一个自己都登不上的账号」这种问题。
func (s *AdminService) CreateUser(ctx context.Context, in CreateUserInput, actor Actor) (*domain.User, error) {
	username := strings.TrimSpace(in.Username)
	email := strings.ToLower(strings.TrimSpace(in.Email))
	nickname := strings.TrimSpace(in.Nickname)

	if fields := validateRegistration(username, email, in.Password, nickname, s.site.PasswordMinLength()); len(fields) > 0 {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(fields)
	}
	role := in.Role
	if role == "" {
		role = domain.Role(s.site.DefaultRole())
	}
	if !role.Valid() {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"role": "角色只能是 user 或 admin",
		})
	}

	if err := s.ensureAvailable(ctx, email, username); err != nil {
		return nil, err
	}

	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return nil, passwordPolicyError(err)
	}
	user, err := s.users.Create(ctx, domain.CreateUserInput{
		UID: id.New(), Username: username, Email: email, PasswordHash: hash,
		Nickname: nickname, Role: role, Status: domain.UserStatusActive, Now: s.now(),
	})
	if err != nil {
		if errors.Is(err, domain.ErrDuplicate) {
			return nil, s.duplicateError(ctx, email, username)
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	_ = s.Record(ctx, AuditEntry{
		Actor: actor, Action: domain.AuditUserCreate, TargetType: "user", TargetID: user.UID,
		Detail: map[string]any{"username": user.Username, "email": user.Email, "role": string(user.Role)},
	})
	return user, nil
}

// AdminUserPatch 是管理员修改用户的入参。
//
// 指针字段区分「没传」与「传了零值」，与 ProfileUpdate 同理：状态要能从
// active 改成 disabled，而「没传 status」不能被当成 disabled。
type AdminUserPatch struct {
	Nickname *string
	Email    *string
	Role     *domain.Role
	Status   *domain.UserStatus
}

// UpdateUser 修改用户资料、角色或状态。
func (s *AdminService) UpdateUser(ctx context.Context, uid string, patch AdminUserPatch, actor Actor) (*domain.User, error) {
	var updated *domain.User
	var oldRole domain.Role
	var oldStatus domain.UserStatus
	err := s.withUserSecurity(ctx, uid, func(ctx context.Context, user *domain.User, state *domain.TwoFactorState) error {
		oldRole, oldStatus = user.Role, user.Status
		var err error
		updated, err = s.updateUser(ctx, user, patch, state)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.auditUserChange(ctx, actor, updated, oldRole, oldStatus)
	return updated, nil
}

func (s *AdminService) updateUser(ctx context.Context, user *domain.User, patch AdminUserPatch, state *domain.TwoFactorState) (*domain.User, error) {
	uid := user.UID
	var err error

	// 先把「会不会把最后一个管理员弄没」判断完，再动手。
	if err := s.guardLastAdmin(ctx, user, patch); err != nil {
		return nil, err
	}

	nickname := user.Nickname
	if patch.Nickname != nil {
		nickname = strings.TrimSpace(*patch.Nickname)
		if len([]rune(nickname)) > maxNicknameRunes {
			return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"nickname": fmt.Sprintf("昵称最多 %d 个字符", maxNicknameRunes),
			})
		}
	}
	email := user.Email
	if patch.Email != nil {
		email = strings.ToLower(strings.TrimSpace(*patch.Email))
		if !emailPattern.MatchString(email) {
			return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"email": "邮箱格式不正确",
			})
		}
		if email != user.Email {
			existing, lookupErr := s.users.GetByEmail(ctx, email)
			if lookupErr == nil && existing.ID != user.ID {
				return nil, apperr.New(apperr.CodeAuthEmailTaken, "")
			}
			if lookupErr != nil && !errors.Is(lookupErr, domain.ErrNotFound) {
				return nil, apperr.Wrap(apperr.CodeInternalError, lookupErr)
			}
		}
	}

	now := s.now()
	updated := user
	if nickname != user.Nickname || email != user.Email {
		if updated, err = s.users.UpdateProfile(ctx, domain.UpdateProfileInput{
			UID: uid, Nickname: nickname, AvatarURL: user.AvatarURL, Now: now,
		}); err != nil {
			return nil, mapAdminUserError(err)
		}
		if email != user.Email {
			updated, err = s.users.UpdateEmail(ctx, uid, email, now)
			if err != nil {
				if errors.Is(err, domain.ErrDuplicate) {
					return nil, apperr.New(apperr.CodeAuthEmailTaken, "")
				}
				return nil, mapAdminUserError(err)
			}
		}
	}
	if patch.Role != nil && *patch.Role != user.Role {
		updated, err = s.users.UpdateRole(ctx, uid, *patch.Role, now)
		if err != nil {
			return nil, mapAdminUserError(err)
		}
	}
	if patch.Status != nil && *patch.Status != user.Status {
		updated, err = s.users.UpdateStatus(ctx, uid, *patch.Status, now)
		if err != nil {
			return nil, mapAdminUserError(err)
		}
		if *patch.Status != domain.UserStatusActive {
			if err := s.revokeSessions(ctx, user.ID, state); err != nil {
				return nil, err
			}
		}
	}

	return updated, nil
}

// auditUserChange 按「实际改了什么」写对应的审计动作。
//
// 一条记录只写一个动作，而不是笼统的 user.update：审计页要能按动作筛选，
// 「谁被降级过」与「谁改过昵称」是两个不同的追问。
func (s *AdminService) auditUserChange(
	ctx context.Context, actor Actor, user *domain.User, oldRole domain.Role, oldStatus domain.UserStatus,
) {
	if user.Role != oldRole {
		_ = s.Record(ctx, AuditEntry{
			Actor: actor, Action: domain.AuditUserRoleChange, TargetType: "user", TargetID: user.UID,
			Detail: map[string]any{"from": string(oldRole), "to": string(user.Role)},
		})
	}
	if user.Status != oldStatus {
		action := domain.AuditUserEnable
		if user.Status != domain.UserStatusActive {
			action = domain.AuditUserDisable
		}
		_ = s.Record(ctx, AuditEntry{
			Actor: actor, Action: action, TargetType: "user", TargetID: user.UID,
			Detail: map[string]any{"from": string(oldStatus), "to": string(user.Status)},
		})
	}
	if user.Role == oldRole && user.Status == oldStatus {
		// 只改了资料（昵称/邮箱）。邮箱是登录标识，值得单独留痕。
		_ = s.Record(ctx, AuditEntry{
			Actor: actor, Action: domain.AuditUserUpdate, TargetType: "user", TargetID: user.UID,
			Detail: map[string]any{"email": user.Email, "nickname": user.Nickname},
		})
	}
}

// guardLastAdmin 阻止「把最后一个可用管理员降级或禁用」。
func (s *AdminService) guardLastAdmin(ctx context.Context, user *domain.User, patch AdminUserPatch) error {
	losesAdmin := (patch.Role != nil && *patch.Role != domain.RoleAdmin && user.Role == domain.RoleAdmin) ||
		(patch.Status != nil && *patch.Status != domain.UserStatusActive && user.IsAdmin())
	if !losesAdmin {
		return nil
	}
	count, err := s.users.CountActiveAdmins(ctx)
	if err != nil {
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	// 只剩这一个可用管理员时拒绝。判据是「当前可用管理员数」，而不是
	// 「是否最后一个 admin 记录」——已经被禁用的 admin 帮不上忙。
	if count <= 1 {
		return apperr.New(apperr.CodeAdminLastAdmin, "")
	}
	return nil
}

// DeleteUser 软删除用户。
//
// 一期没有导图表（M2 才有），map_strategy 参数保留但只做校验，实际处理
// 在 M2 接入导图仓储后补上。
func (s *AdminService) DeleteUser(ctx context.Context, uid string, actor Actor) error {
	var deleted *domain.User
	err := s.withUserSecurity(ctx, uid, func(ctx context.Context, user *domain.User, state *domain.TwoFactorState) error {
		if actor.UID != "" && actor.UID == user.UID {
			return apperr.New(apperr.CodeAdminCannotDeleteSelf, "")
		}
		if user.IsAdmin() && user.IsActive() {
			count, err := s.users.CountActiveAdmins(ctx)
			if err != nil {
				return apperr.Wrap(apperr.CodeInternalError, err)
			}
			if count <= 1 {
				return apperr.New(apperr.CodeAdminLastAdmin, "")
			}
		}

		if err := s.users.SoftDelete(ctx, uid, s.now()); err != nil {
			return mapAdminUserError(err)
		}
		deleted = user
		return s.revokeSessions(ctx, user.ID, state)
	})
	if err != nil {
		return err
	}
	_ = s.Record(ctx, AuditEntry{
		Actor: actor, Action: domain.AuditUserDelete, TargetType: "user", TargetID: deleted.UID,
		Detail: map[string]any{"username": deleted.Username, "email": deleted.Email},
	})
	return nil
}

// ResetPasswordResult 是重置密码的结果。
//
// 明文密码只在这个结构里出现一次，绝不落库、不写日志、不写审计。
type ResetPasswordResult struct {
	Password  string
	Generated bool
}

// ResetPassword 由管理员重置指定用户的密码。
//
// 这是本期账号找回的唯一入口（不接入 SMTP），所以「一次性返回明文」是
// 有意的设计：管理员要把它转告用户。服务端只存哈希。
func (s *AdminService) ResetPassword(ctx context.Context, uid, password string, actor Actor) (*ResetPasswordResult, error) {
	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		return nil, mapAdminUserError(err)
	}
	// 重置自己会让当前会话全部失效，等于把自己锁在门外；改自己的密码走
	// POST /users/me/password（它会保留当前设备）。
	if actor.UID != "" && actor.UID == user.UID {
		return nil, apperr.New(apperr.CodeAdminCannotResetSelf, "")
	}

	generated := strings.TrimSpace(password) == ""
	if generated {
		password, err = auth.GeneratePassword(auth.GeneratedPasswordLength)
		if err != nil {
			return nil, apperr.Wrap(apperr.CodeInternalError, err)
		}
	} else if err := auth.ValidatePassword(password, s.site.PasswordMinLength()); err != nil {
		return nil, passwordPolicyError(err)
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, passwordPolicyError(err)
	}
	err = s.withUserSecurity(ctx, uid, func(ctx context.Context, current *domain.User, state *domain.TwoFactorState) error {
		if err := s.users.UpdatePassword(ctx, current.ID, hash, s.now()); err != nil {
			return apperr.Wrap(apperr.CodeInternalError, err)
		}
		return s.revokeSessions(ctx, current.ID, state)
	})
	if err != nil {
		return nil, err
	}

	// 审计只记「发生了重置」与「是否随机生成」，绝不记密码本身。
	_ = s.Record(ctx, AuditEntry{
		Actor: actor, Action: domain.AuditUserPasswordReset, TargetType: "user", TargetID: user.UID,
		Detail: map[string]any{"generated": generated, "username": user.Username},
	})
	return &ResetPasswordResult{Password: password, Generated: generated}, nil
}

// Stats 返回管理后台概览。趋势按 UTC 自然日连续补齐 14 天。
func (s *AdminService) Stats(ctx context.Context) (*domain.AdminStats, error) {
	now := s.now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	from := today.AddDate(0, 0, -13)
	stats, err := s.stats.Read(ctx, from, today.AddDate(0, 0, 1))
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	uploadBytes, err := s.uploads.Usage(ctx)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	stats.StorageUsedBytes += uploadBytes
	byDay := make(map[string]domain.AdminTrendPoint, len(stats.Trend))
	for _, point := range stats.Trend {
		byDay[point.Date] = point
	}
	stats.Trend = make([]domain.AdminTrendPoint, 14)
	for i := range stats.Trend {
		day := from.AddDate(0, 0, i).Format("2006-01-02")
		point := byDay[day]
		point.Date = day
		stats.Trend[i] = point
	}
	stats.MapCountToday = stats.Trend[13].NewMaps
	return stats, nil
}

// AuditQuery 是审计日志的查询条件（对外形态）。
//
// ActorUID 用 uid 而不是自增主键：前端只见过 uid，让它去猜主键既不可能
// 也不该暴露。转换在这里做，仓储只认主键。
type AuditQuery struct {
	Action   string
	ActorUID string
	From     *time.Time
	To       *time.Time
	Page     domain.Page
}

// ListAuditLogs 返回审计日志与总数。
func (s *AdminService) ListAuditLogs(ctx context.Context, query AuditQuery) ([]*domain.AuditLog, int64, error) {
	filter := domain.AuditFilter{Action: query.Action, From: query.From, To: query.To}
	if uid := strings.TrimSpace(query.ActorUID); uid != "" {
		actorUser, err := s.users.GetByUID(ctx, uid)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				// 没有这个操作人 = 没有他的记录。返回空集而不是 404：
				// 「筛不到」是正常的查询结果，不是错误。
				return nil, 0, nil
			}
			return nil, 0, apperr.Wrap(apperr.CodeInternalError, err)
		}
		filter.ActorID = &actorUser.ID
	}

	logs, err := s.audit.List(ctx, filter, query.Page)
	if err != nil {
		return nil, 0, apperr.Wrap(apperr.CodeInternalError, err)
	}
	total, err := s.audit.Count(ctx, filter)
	if err != nil {
		return nil, 0, apperr.Wrap(apperr.CodeInternalError, err)
	}
	return logs, total, nil
}

// withUserSecurity follows the login/refresh lock order: security row, then user
// mutation and token rows. Every account change is committed with revocation.
func (s *AdminService) withUserSecurity(ctx context.Context, uid string, fn func(context.Context, *domain.User, *domain.TwoFactorState) error) error {
	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		return mapAdminUserError(err)
	}
	return s.tx.WithTx(ctx, func(ctx context.Context) error {
		if err := s.twoFactor.Ensure(ctx, user.ID); err != nil {
			return err
		}
		state, err := s.twoFactor.Get(ctx, user.ID, true)
		if err != nil {
			return err
		}
		current, err := s.users.GetByUID(ctx, uid)
		if err != nil {
			return mapAdminUserError(err)
		}
		return fn(ctx, current, state)
	})
}

// revokeSessions requires the security-row lock and an enclosing transaction.
func (s *AdminService) revokeSessions(ctx context.Context, userID int64, state *domain.TwoFactorState) error {
	version, _, err := auth.NewRefreshToken()
	if err != nil {
		return err
	}
	state.SessionVersion = version
	state.Challenges = nil
	if err := s.twoFactor.Save(ctx, userID, state); err != nil {
		return err
	}
	_, err = s.tokens.RevokeAllForUser(ctx, userID, s.now())
	return err
}

// ensureAvailable 提前查出邮箱/用户名冲突，给出准确错误码。
func (s *AdminService) ensureAvailable(ctx context.Context, email, username string) error {
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

// duplicateError 在并发穿过唯一约束时判断是哪个字段撞了。
func (s *AdminService) duplicateError(ctx context.Context, email, username string) error {
	if _, err := s.users.GetByEmail(ctx, email); err == nil {
		return apperr.New(apperr.CodeAuthEmailTaken, "")
	}
	if _, err := s.users.GetByUsername(ctx, username); err == nil {
		return apperr.New(apperr.CodeAuthUsernameTaken, "")
	}
	// 查不到说明冲突方刚好被删了，仍按冲突返回（客户端重试即可）。
	return apperr.New(apperr.CodeAuthEmailTaken, "")
}

// mapAdminUserError 把仓储哨兵错误翻译成管理端的错误码。
//
// 不能复用 user.go 的 mapUserError：那个版本把 ErrNotFound 翻成
// AUTH_TOKEN_INVALID（自助接口里「令牌指向的用户没了」确实是 401），
// 而管理端「这个 uid 不存在」应该是 404，否则管理员会以为自己掉登录了。
func mapAdminUserError(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return apperr.New(apperr.CodeResourceNotFound, "")
	}
	if errors.Is(err, domain.ErrDuplicate) {
		return apperr.New(apperr.CodeAuthEmailTaken, "")
	}
	return apperr.Wrap(apperr.CodeInternalError, err)
}

// 让 AdminService 满足 Auditor。
var _ Auditor = (*AdminService)(nil)
