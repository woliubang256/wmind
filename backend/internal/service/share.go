package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
)

const (
	// DefaultMaxLinksPerMap 是单张导图的分享链接上限（站点设置可覆盖）。
	//
	// 20 是「够用且有界」：同一个人对一张图不会需要 20 条不同的链接，而
	// 上限存在的意义是让「一个脚本刷一万条链接」变成不可能。
	DefaultMaxLinksPerMap = 20

	// minSharePasswordRunes / maxSharePasswordRunes 是分享密码的长度范围。
	//
	// 下限刻意只有 4 位，与账号密码的 8 位不同：分享链接的密码是一道
	// 「别让转发出去的人随便点开」的轻门槛，不是身份凭证。要求 8 位以上
	// 只会把用户推去复用他的账号密码——那才是真的危险。
	minSharePasswordRunes = 4
	maxSharePasswordRunes = 64

	// maxShareExpireDays 是链接有效期的上限（10 年，等价于「永久」）。
	//
	// 上限存在是为了让 `expiresInDays` 不能用来构造一个 100 年后的时间戳
	// 把 expires_at 溢出成非法值。
	maxShareExpireDays = 3650
)

// SharePolicy 是分享服务需要的站点策略。
//
// 与 MapLimits / SiteConfigProvider 同一套路：service 层不知道设置是怎么存
// 的，生产实现是 settings.Service 的快照访问器，测试里给一个固定值即可。
type SharePolicy interface {
	// ShareEnabled 报告站点是否允许分享（share.public_link_enabled）。
	//
	// 它同时管两件事：不允许创建新链接，以及让**所有**历史链接立即失效
	// （验收标准 11）。后者是运营关闭分享时的真实诉求——只挡住新建，已经
	// 转发出去的链接照样能打开，等于没关。
	ShareEnabled() bool
	// ShareRequirePassword 报告是否强制所有链接设密码。
	ShareRequirePassword() bool
	// ShareMaxLinksPerMap 返回单张导图的链接上限；<= 0 表示不限。
	ShareMaxLinksPerMap() int
	// SiteBaseURL 返回站点对外地址（用于拼分享 URL），可为空。
	SiteBaseURL() string
}

// ShareServiceConfig 是 ShareService 的依赖。
type ShareServiceConfig struct {
	Shares domain.ShareRepo
	Maps   domain.MapRepo
	Policy SharePolicy
	// Tokens 签发密码校验通过后的短期访问凭证。
	Tokens *auth.ShareTokenIssuer
	// Views 是访问计数去重表；为 nil 时不去重（每次访问都计数）。
	Views *ViewDeduper
	Now   Clock
}

// ShareService 管理分享链接与公开访问。
//
// 它**不负责**审计写入：那由 handler 用 service.Auditor 完成，与设置接口
// 的做法一致（见 handler/settings.go）。审计要拿到请求 IP，而 IP 是 HTTP
// 层的东西，不该渗进业务方法签名。
type ShareService struct {
	shares domain.ShareRepo
	maps   domain.MapRepo
	policy SharePolicy
	tokens *auth.ShareTokenIssuer
	views  *ViewDeduper
	now    Clock
}

// NewShareService 构造分享服务。
func NewShareService(cfg ShareServiceConfig) (*ShareService, error) {
	if cfg.Shares == nil {
		return nil, errors.New("ShareService 需要分享仓储")
	}
	if cfg.Maps == nil {
		return nil, errors.New("ShareService 需要导图仓储")
	}
	if cfg.Tokens == nil {
		return nil, errors.New("ShareService 需要分享令牌签发器")
	}
	if cfg.Now == nil {
		cfg.Now = SystemClock
	}
	return &ShareService{
		shares: cfg.Shares, maps: cfg.Maps, policy: cfg.Policy,
		tokens: cfg.Tokens, views: cfg.Views, now: cfg.Now,
	}, nil
}

// CreateShareInput 是创建分享链接的入参。
type CreateShareInput struct {
	// Password 为空表示无访问密码。
	Password string
	// ExpiresInDays 为 0 表示永久有效。
	ExpiresInDays int
	AllowDownload bool
	ShowNotes     bool
}

// UpdateShareInput 是改写分享设置的入参。
//
// 全部是指针：nil 表示「这次不改这个字段」，而不是「改成零值」。少了这层
// 区分，前端只想关掉「允许下载」时会把密码和有效期一起清空。
type UpdateShareInput struct {
	Password      *string
	ExpiresInDays *int
	AllowDownload *bool
	ShowNotes     *bool
}

// PublicShare 是公开访问解析出的渲染数据（已剥离备注与内部字段）。
type PublicShare struct {
	Title         string
	Document      []byte
	AllowDownload bool
	ShowNotes     bool
	OwnerNickname string
	CreatedAt     time.Time
	ExpiresAt     *time.Time
}

// Create 为某张导图创建分享链接。
func (s *ShareService) Create(ctx context.Context, mapUID string, ownerID int64, in CreateShareInput) (*domain.ShareLink, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	// 先取导图：既做属主校验（跨用户返回 404 而不是 403），也拿到内部
	// map_id——后面的配额统计与写入都要用它，避免再查一次。
	target, err := s.maps.GetByUID(ctx, mapUID, ownerID)
	if err != nil {
		return nil, mapMapError(err)
	}

	password := strings.TrimSpace(in.Password)
	if password == "" && s.policy != nil && s.policy.ShareRequirePassword() {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"password": "本站要求分享链接必须设置访问密码",
		})
	}
	passwordHash, err := hashSharePassword(password)
	if err != nil {
		return nil, err
	}

	if limit := s.maxLinksPerMap(); limit > 0 {
		active, err := s.shares.CountActiveByMap(ctx, target.ID)
		if err != nil {
			return nil, mapShareError(err)
		}
		if active >= int64(limit) {
			return nil, apperr.New(apperr.CodeShareLimitReached, "").WithDetail("limit", limit)
		}
	}

	expiresAt, err := s.expiryFrom(in.ExpiresInDays)
	if err != nil {
		return nil, err
	}

	created, err := s.shares.Create(ctx, domain.CreateShareInput{
		UID:           id.New(),
		Token:         newShareToken(),
		MapID:         target.ID,
		OwnerID:       ownerID,
		PasswordHash:  passwordHash,
		AllowDownload: in.AllowDownload,
		ShowNotes:     in.ShowNotes,
		ExpiresAt:     expiresAt,
		Now:           s.now(),
	})
	if err != nil {
		return nil, mapShareError(err)
	}
	// RETURNING 不带 JOIN，这里补上（见 domain.ShareLink 的注释）。
	created.MapUID = target.UID
	created.MapTitle = target.Title
	return created, nil
}

// ListByMap 返回某张导图的全部分享链接（含已撤销的）。
func (s *ShareService) ListByMap(ctx context.Context, mapUID string, ownerID int64) ([]*domain.ShareLink, error) {
	target, err := s.maps.GetByUID(ctx, mapUID, ownerID)
	if err != nil {
		return nil, mapMapError(err)
	}
	list, err := s.shares.ListByMap(ctx, target.ID, ownerID)
	if err != nil {
		return nil, mapShareError(err)
	}
	return list, nil
}

// ListMine 返回当前用户创建的全部分享链接。
func (s *ShareService) ListMine(ctx context.Context, ownerID int64, mapUID string, page, pageSize int) ([]*domain.ShareLink, int64, error) {
	p := domain.NewPage(page, pageSize)
	list, err := s.shares.ListByOwner(ctx, ownerID, strings.TrimSpace(mapUID), p)
	if err != nil {
		return nil, 0, mapShareError(err)
	}
	total, err := s.shares.CountByOwner(ctx, ownerID, strings.TrimSpace(mapUID))
	if err != nil {
		return nil, 0, mapShareError(err)
	}
	return list, total, nil
}

// Update 改写分享设置。只有显式传入的字段会变。
func (s *ShareService) Update(ctx context.Context, shareUID string, ownerID int64, in UpdateShareInput) (*domain.ShareLink, error) {
	current, err := s.shares.GetByUID(ctx, shareUID, ownerID)
	if err != nil {
		return nil, mapShareError(err)
	}

	next := domain.UpdateShareInput{
		UID:           current.UID,
		OwnerID:       ownerID,
		PasswordHash:  current.PasswordHash,
		AllowDownload: current.AllowDownload,
		ShowNotes:     current.ShowNotes,
		ExpiresAt:     current.ExpiresAt,
	}

	if in.Password != nil {
		password := strings.TrimSpace(*in.Password)
		if password == "" && s.policy != nil && s.policy.ShareRequirePassword() {
			return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"password": "本站要求分享链接必须设置访问密码",
			})
		}
		hash, err := hashSharePassword(password)
		if err != nil {
			return nil, err
		}
		next.PasswordHash = hash
	}
	if in.ExpiresInDays != nil {
		expiresAt, err := s.expiryFrom(*in.ExpiresInDays)
		if err != nil {
			return nil, err
		}
		next.ExpiresAt = expiresAt
	}
	if in.AllowDownload != nil {
		next.AllowDownload = *in.AllowDownload
	}
	if in.ShowNotes != nil {
		next.ShowNotes = *in.ShowNotes
	}

	updated, err := s.shares.Update(ctx, next)
	if err != nil {
		return nil, mapShareError(err)
	}
	// 与 Create 同理：RETURNING 没有 JOIN，用读出来的那一行补上。
	updated.MapUID = current.MapUID
	updated.MapTitle = current.MapTitle
	return updated, nil
}

// Revoke 撤销分享链接。
//
// 不删行：撤销之后「这条链接被看过多少次」才是最想知道的信息（docs/04 §5.7）。
func (s *ShareService) Revoke(ctx context.Context, shareUID string, ownerID int64) error {
	return mapShareError(s.shares.Revoke(ctx, shareUID, ownerID, s.now()))
}

// ReadPublic 解析一次公开访问，返回可直接渲染的数据。
//
// accessToken 是前端从 sessionStorage 取出来放在 X-Share-Access 头里的凭证，
// ip 只用于访问计数去重。
//
// 失效四态（令牌不存在 / 已撤销 / 已过期 / 导图已删除）返回**同一个**
// 404 SHARE_NOT_FOUND，不区分原因：区分了就等于告诉外人「这个令牌曾经存在」。
func (s *ShareService) ReadPublic(ctx context.Context, token, accessToken, ip string) (*PublicShare, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, apperr.New(apperr.CodeShareNotFound, "")
	}
	found, err := s.shares.GetByToken(ctx, token)
	if err != nil {
		return nil, mapShareError(err)
	}
	share := found.Share
	now := s.now()
	if !share.Usable(now) || found.MapDeleted {
		return nil, apperr.New(apperr.CodeShareNotFound, "")
	}
	if share.HasPassword() {
		if err := s.checkAccessToken(accessToken, share.UID); err != nil {
			return nil, err
		}
	}

	stripped, err := stripShareDocument(found.Document, share.ShowNotes)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	// 计数放在剥离之后：解析失败的访问不该被算作一次有效浏览。
	//
	// 计数失败不影响这次访问：访客要的是内容，不是统计的准确性。刻意吞掉
	// 错误也不打日志——一条每 30 分钟最多出现一次的写失败不值得污染日志。
	if s.views == nil || s.views.Mark(shareViewKey(share.Token, ip)) {
		_ = s.shares.RecordView(ctx, share.ID, now)
	}

	return &PublicShare{
		Title:         found.Share.MapTitle,
		Document:      stripped,
		AllowDownload: share.AllowDownload,
		ShowNotes:     share.ShowNotes,
		OwnerNickname: found.OwnerNickname,
		CreatedAt:     share.CreatedAt,
		ExpiresAt:     share.ExpiresAt,
	}, nil
}

// VerifyPassword 校验分享密码，成功时签发短期访问凭证。
func (s *ShareService) VerifyPassword(ctx context.Context, token, password string) (string, int, error) {
	if err := s.requireEnabled(); err != nil {
		return "", 0, err
	}
	found, err := s.shares.GetByToken(ctx, strings.TrimSpace(token))
	if err != nil {
		return "", 0, mapShareError(err)
	}
	share := found.Share
	if !share.Usable(s.now()) || found.MapDeleted {
		return "", 0, apperr.New(apperr.CodeShareNotFound, "")
	}
	if !share.HasPassword() {
		// 没有密码却来校验：不是攻击，是前端状态错乱（或用户直接调了接口）。
		// 返回 422 而不是 200，避免前端误以为「拿到了凭证」。
		return "", 0, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"password": "该分享不需要访问密码",
		})
	}
	if !auth.VerifyPassword(share.PasswordHash, password) {
		// 返回的错误里不带任何「差多少」的信息：密码校验失败只有一种答案。
		return "", 0, apperr.New(apperr.CodeSharePasswordInvalid, "")
	}
	accessToken, expiresIn, err := s.tokens.Issue(share.UID)
	if err != nil {
		return "", 0, apperr.Wrap(apperr.CodeInternalError, err)
	}
	return accessToken, expiresIn, nil
}

// checkAccessToken 校验访问凭证是否属于这条分享。
//
// 凭证无效与凭证属于**别的**分享，都返回 SHARE_PASSWORD_REQUIRED 而不是
// SHARE_PASSWORD_INVALID：对前端来说这两种情况的处理完全一样（弹出密码框），
// 而区分它们只会多一条没人用的分支。
func (s *ShareService) checkAccessToken(raw, shareUID string) error {
	if strings.TrimSpace(raw) == "" {
		return apperr.New(apperr.CodeSharePasswordRequired, "")
	}
	uid, err := s.tokens.Parse(raw)
	if err != nil || uid != shareUID {
		return apperr.New(apperr.CodeSharePasswordRequired, "")
	}
	return nil
}

// ShareURL 把令牌拼成对外链接。
//
// 站点没配 `site.base_url` 时返回站内相对路径 `/s/<token>`：调用方（前端）
// 用 `new URL(path, location.origin)` 就能得到绝对地址，比在这里猜一个
// Host 更可靠——服务端看到的 Host 在反向代理后面经常不是用户访问的那个。
func (s *ShareService) ShareURL(token string) string {
	base := ""
	if s.policy != nil {
		base = strings.TrimRight(strings.TrimSpace(s.policy.SiteBaseURL()), "/")
	}
	return base + "/s/" + token
}

func (s *ShareService) requireEnabled() error {
	if s.policy != nil && !s.policy.ShareEnabled() {
		return apperr.New(apperr.CodeShareDisabled, "")
	}
	return nil
}

func (s *ShareService) maxLinksPerMap() int {
	if s.policy == nil {
		return DefaultMaxLinksPerMap
	}
	if limit := s.policy.ShareMaxLinksPerMap(); limit > 0 {
		return limit
	}
	return 0
}

// expiryFrom 把「有效天数」换算成绝对时间。0 表示永久（nil）。
func (s *ShareService) expiryFrom(days int) (*time.Time, error) {
	if days == 0 {
		return nil, nil
	}
	if days < 0 || days > maxShareExpireDays {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"expiresInDays": "有效期应在 0 到 3650 天之间",
		})
	}
	at := s.now().UTC().AddDate(0, 0, days)
	return &at, nil
}

// hashSharePassword 校验并哈希分享密码；空串表示不设密码。
func hashSharePassword(password string) (string, error) {
	if password == "" {
		return "", nil
	}
	runes := len([]rune(password))
	if runes < minSharePasswordRunes {
		return "", apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"password": "访问密码至少 4 位",
		})
	}
	if runes > maxSharePasswordRunes {
		return "", apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"password": "访问密码最多 64 位",
		})
	}
	// bcrypt 只认前 72 字节，超出部分会被静默截断。这里显式拒绝，否则
	// 用户以为自己设了更长的密码（与 auth.HashPassword 的约定一致）。
	if len(password) > auth.MaxPasswordBytes {
		return "", apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"password": "访问密码过长",
		})
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return "", apperr.Wrap(apperr.CodeInternalError, err)
	}
	return hash, nil
}

// newShareToken 生成分享令牌：16 字节随机数的 base64url 编码（22 字符）。
//
// 用 base64url 而不是十六进制：同样 128 bit 熵，十六进制是 32 个字符，
// base64url 只有 22 个，而链接是要被人复制粘贴甚至念出来的。
// RawURLEncoding 去掉 `=` 填充，令牌里就不会出现需要转义的字符。
func newShareToken() string {
	buf := make([]byte, domain.ShareTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		// 与 pkg/id 一致：熵源异常时继续运行只会产出可预测的令牌。
		panic("service: 读取随机源失败: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// mapShareError 把仓储错误翻译成对外的错误码。
func mapShareError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, domain.ErrNotFound):
		return apperr.New(apperr.CodeShareNotFound, "")
	case errors.Is(err, domain.ErrDuplicate):
		// 令牌冲突意味着 128 bit 随机源撞了——概率上不可能发生，真发生了
		// 说明随机源坏了，返回 500 让人看见，而不是悄悄重试掩盖问题。
		return apperr.Wrap(apperr.CodeInternalError, err)
	default:
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
}
