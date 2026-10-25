package settings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// DefaultTTL 是多实例部署下的兜底刷新周期（docs/03 §4.4）。
//
// 单实例时 PUT 会立即重载，TTL 只是保险；多实例时它决定了「A 实例改了设置，
// B 实例多久后看到」。60 秒是一个够用又不至于把库读热的折中。
const DefaultTTL = 60 * time.Second

// Config 是 Service 的依赖。
type Config struct {
	Logger *slog.Logger
	Tx     domain.TxManager
	Now    func() time.Time
	TTL    time.Duration
}

// Service 持有设置快照，并负责写入后重载。
//
// 读路径无锁：current 是 atomic.Value，指向一份不可变 Snapshot。
type Service struct {
	repo   domain.SettingsRepo
	tx     domain.TxManager
	logger *slog.Logger
	now    func() time.Time
	ttl    time.Duration

	// reloadMu 串行化重载，避免并发 PUT 时多个 goroutine 同时打库。
	reloadMu sync.Mutex
	current  atomic.Value // *Snapshot
}

// New 构造设置服务。repo 为必需依赖。
func New(repo domain.SettingsRepo, cfg Config) (*Service, error) {
	if repo == nil {
		return nil, errors.New("settings 需要仓储")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.TTL <= 0 {
		cfg.TTL = DefaultTTL
	}
	s := &Service{
		repo: repo, tx: cfg.Tx, logger: cfg.Logger, now: cfg.Now, ttl: cfg.TTL,
	}
	// 先放一份默认值：Load 之前就被调用也不会 panic（例如启动早期有请求进来）。
	defaults, err := defaultSnapshot(cfg.Now())
	if err != nil {
		return nil, err
	}
	s.current.Store(defaults)
	return s, nil
}

// Load 从库里全量加载设置，启动时调用一次。
//
// 读失败不阻断启动：站点用默认值起来比起不来好，管理员登录后台就能发现问题。
// 代价是「设置暂时回到默认」，所以必须打 ERROR 日志。
func (s *Service) Load(ctx context.Context) error {
	if err := s.Reload(ctx); err != nil {
		s.logger.Error("加载站点设置失败，暂时使用默认值", "err", err)
		return err
	}
	return nil
}

// Reload 重新读库并替换快照。
func (s *Service) Reload(ctx context.Context) error {
	s.reloadMu.Lock()
	defer s.reloadMu.Unlock()

	rows, err := s.repo.List(ctx)
	if err != nil {
		return fmt.Errorf("读取站点设置: %w", err)
	}

	values := make(map[string]any, len(specs))
	for _, spec := range specs {
		value, err := spec.defaultValue()
		if err != nil {
			return err
		}
		values[spec.Key] = value
	}

	for _, row := range rows {
		// Private records are encrypted and managed by their own services.
		if strings.HasPrefix(row.Key, "backup.") || strings.HasPrefix(row.Key, "ai.") {
			continue
		}
		spec, ok := Lookup(row.Key)
		if !ok {
			// 库里有本版本不认识的键：可能是降级运行，或某个键在新版本被删了。
			// 忽略而不是报错，否则一次降级就会让站点起不来。
			s.logger.Warn("忽略未知的设置项", "key", row.Key)
			continue
		}
		value, err := spec.parseStored(row.Value)
		if err != nil {
			// 单个键损坏只影响它自己：退回默认值并告警，其余照常生效。
			s.logger.Error("设置项的值非法，已退回默认值", "key", row.Key, "raw", row.Value, "err", err)
			continue
		}
		values[row.Key] = value
	}

	s.current.Store(&Snapshot{values: values, loadedAt: s.now()})
	return nil
}

// Snapshot 返回当前快照。调用方不应缓存它——每次读都要拿最新的。
func (s *Service) Snapshot() *Snapshot {
	if snapshot, ok := s.current.Load().(*Snapshot); ok {
		return snapshot
	}
	// 理论上不可达（New 已存入默认值），兜底避免 nil 解引用。
	defaults, err := defaultSnapshot(s.now())
	if err != nil {
		return &Snapshot{values: map[string]any{}, loadedAt: s.now()}
	}
	return defaults
}

// Run 启动 TTL 兜底刷新，直到 ctx 结束。
//
// 用后台 ticker 而不是「读的时候检查是否过期」：后者会把一次同步的库读
// 塞进任意请求的延迟里，而且并发请求会同时发现过期、同时去打库。
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(s.ttl)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Reload(ctx); err != nil && ctx.Err() == nil {
				s.logger.Warn("定时重载站点设置失败", "err", err)
			}
		}
	}
}

// Update 校验并写入一批设置项，成功后重载快照。
//
// patch 的键必须是 schema 里注册过的；值可以是 bool / string / json.Number
// （handler 用 UseNumber 解码，避免 int 变成 float64 丢精度）。
func (s *Service) Update(ctx context.Context, patch map[string]any, actorID *int64) (*Snapshot, error) {
	if len(patch) == 0 {
		return s.Snapshot(), nil
	}

	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	// 先整体校验再写：一半键写进去、另一半非法会让设置处于自相矛盾的状态
	// （例如「关掉注册」成功但「改密码长度」失败，管理员会以为两件都失败了）。
	values := make(map[string]any, len(patch))
	fieldErrors := make(map[string]string)
	for _, key := range keys {
		spec, ok := Lookup(key)
		if !ok {
			fieldErrors[key] = "未知的设置项"
			continue
		}
		value, err := spec.parse(patch[key])
		if err != nil {
			fieldErrors[key] = err.Error()
			continue
		}
		values[key] = value
	}
	if len(fieldErrors) > 0 {
		return nil, apperr.New(apperr.CodeSettingsInvalid, "").WithFieldErrors(fieldErrors)
	}

	write := func(ctx context.Context) error {
		now := s.now()
		for _, key := range keys {
			encoded, err := mustSpec(key).encode(values[key])
			if err != nil {
				return err
			}
			if err := s.repo.Upsert(ctx, key, encoded, actorID, now); err != nil {
				return fmt.Errorf("写入设置项 %s: %w", key, err)
			}
		}
		return nil
	}

	var err error
	if s.tx != nil {
		err = s.tx.WithTx(ctx, write)
	} else {
		err = write(ctx)
	}
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	if err := s.Reload(ctx); err != nil {
		// 写已经成功，读不回来只是内存陈旧。用「旧快照 + 本次改动」兜住，
		// 保证接口响应与库一致；下一次 TTL 刷新会修正。
		s.logger.Error("设置已写入但重载失败，使用合并后的快照", "err", err)
		return s.merge(values), nil
	}
	return s.Snapshot(), nil
}

// merge 把 values 叠加到当前快照上，返回新快照（不修改原对象）。
func (s *Service) merge(values map[string]any) *Snapshot {
	base := s.Snapshot()
	merged := make(map[string]any, len(base.values)+len(values))
	for key, value := range base.values {
		merged[key] = value
	}
	for key, value := range values {
		merged[key] = value
	}
	return &Snapshot{values: merged, loadedAt: s.now()}
}

// mustSpec 在已经 Lookup 成功的前提下取 Spec，省掉重复的 ok 判断。
func mustSpec(key string) Spec {
	spec, _ := Lookup(key)
	return spec
}

// RegistrationEnabled 报告是否开放注册。
//
// 每次都读当前快照，所以管理员关掉注册后下一个请求立刻生效——这也是认证
// 路径必须拿到 Service 而不是某一份 Snapshot 的原因。
func (s *Service) RegistrationEnabled() bool { return s.Snapshot().RegistrationEnabled() }

// PasswordMinLength 返回密码最小长度。
func (s *Service) PasswordMinLength() int { return s.Snapshot().PasswordMinLength() }

// DefaultRole 返回新注册用户的默认角色。
func (s *Service) DefaultRole() string { return s.Snapshot().DefaultRole() }

// MapsPerUser 返回每个用户的导图数量上限；0 表示不限制。
//
// 和上面几个一样每次都读当前快照：管理员调小上限后，下一个创建请求
// 就该被拦住，而不是等重启。
func (s *Service) MapsPerUser() int { return s.Snapshot().MapsPerUser() }

func (s *Service) TrashRetentionDays() int { return s.Snapshot().TrashRetentionDays() }

// 编译期确认 Service 满足认证流程需要的站点配置接口。
//
// 不 import service 包（会形成反向依赖），只在这里声明方法集——调用方
// service.SiteConfigProvider 是结构接口，方法名对上即可。
var _ interface {
	RegistrationEnabled() bool
	PasswordMinLength() int
	DefaultRole() string
} = (*Service)(nil)

// ShareEnabled 报告站点是否允许分享。
//
// 它同时是「能不能新建链接」和「历史链接还能不能用」的开关：运营关掉分享
// 时的诉求是后者，只挡新建等于没关（验收标准 11）。
func (s *Service) ShareEnabled() bool { return s.Snapshot().Bool("share.public_link_enabled") }

// ShareRequirePassword 报告是否强制分享链接设密码。
func (s *Service) ShareRequirePassword() bool { return s.Snapshot().Bool("share.require_password") }

// ShareMaxLinksPerMap 返回单张导图的分享链接上限。
func (s *Service) ShareMaxLinksPerMap() int { return s.Snapshot().Int("share.max_links_per_map") }

// ShareDefaultExpireDays 返回新建分享链接的默认有效期（0 = 永久）。
func (s *Service) ShareDefaultExpireDays() int { return s.Snapshot().Int("share.default_expire_days") }

// ShareDefaultAllowDownload 返回新建分享链接「允许下载」的默认值。
func (s *Service) ShareDefaultAllowDownload() bool {
	return s.Snapshot().Bool("share.default_allow_download")
}

// SiteBaseURL 返回站点对外地址，用于拼接分享链接。
//
// 空串表示未配置：此时分享 URL 退化为站内相对路径 /s/<token>，由前端用
// 当前 origin 补全。服务端看不到用户实际访问的域名（反向代理后面尤其如此），
// 所以宁可让前端补，也不在这里猜。
func (s *Service) SiteBaseURL() string { return s.Snapshot().String("site.base_url") }

// UserTemplateEnabled 报告站点是否允许用户自建模板。
//
// 关掉它不影响内置的 8 个模板：那些编译进前端包，不经过服务端，所以
// 「关闭用户模板」的意思精确地是「不能再把自己的导图存成模板」。
func (s *Service) UserTemplateEnabled() bool {
	return s.Snapshot().Bool("feature.user_template_enabled")
}

// 编译期确认 Service 满足模板服务需要的站点策略接口（service.TemplatePolicy）。
var _ interface {
	UserTemplateEnabled() bool
} = (*Service)(nil)

// 编译期确认 Service 满足分享服务需要的站点策略接口（service.SharePolicy）。
var _ interface {
	ShareEnabled() bool
	ShareRequirePassword() bool
	ShareMaxLinksPerMap() int
	SiteBaseURL() string
} = (*Service)(nil)
