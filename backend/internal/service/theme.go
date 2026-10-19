package service

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
)

const (
	// maxThemeNameRunes 与前端主题名输入框一致。
	maxThemeNameRunes = 64

	// maxThemeConfigBytes 是一份 Theme 的大小上限。
	//
	// 一份完整主题（调色板 + 六个角色样式 + 布局开关）序列化后约 2~4 KB，
	// 64 KiB 给了十几倍余量。上限的作用不是省空间，而是拒绝病态输入：
	// 没有它，一个 5 MB 的 config 会先落库再被读进每一台设备的列表里。
	maxThemeConfigBytes = 64 << 10

	// DefaultMaxThemesPerUser 是每个用户的自定义主题数量上限。
	//
	// 主题是「几十个颜色」级别的小对象，50 个足够重度用户折腾；上限存在的
	// 意义是防脚本刷表，而不是产品限制。
	DefaultMaxThemesPerUser = 50
)

// hexColor 匹配 #RRGGBB。三位简写与 rgba() 都不收：前者会让对比度校验脚本
// 与运行时解析器产生两种理解，后者在 SVG 导出里不一定被支持。
var hexColor = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// ThemeServiceConfig 是 ThemeService 的依赖。
type ThemeServiceConfig struct {
	Themes           domain.ThemeRepo
	Now              Clock
	MaxThemesPerUser int
}

// ThemeService 管理用户自定义主题。
//
// 它**不提供**内置配色：那 10 套是前端包内的静态资源，编辑器首帧就要用，
// 不能等一个请求。见 domain.Theme 的注释与 docs/04 §5.5。
type ThemeService struct {
	themes    domain.ThemeRepo
	now       Clock
	maxThemes int
}

// NewThemeService 构造主题服务。
func NewThemeService(cfg ThemeServiceConfig) (*ThemeService, error) {
	if cfg.Themes == nil {
		return nil, errors.New("ThemeService 需要主题仓储")
	}
	if cfg.Now == nil {
		cfg.Now = SystemClock
	}
	if cfg.MaxThemesPerUser <= 0 {
		cfg.MaxThemesPerUser = DefaultMaxThemesPerUser
	}
	return &ThemeService{themes: cfg.Themes, now: cfg.Now, maxThemes: cfg.MaxThemesPerUser}, nil
}

// CreateThemeInput 是创建自定义主题的入参。
type CreateThemeInput struct {
	Name   string
	Config []byte
}

// UpdateThemeInput 是更新自定义主题的入参。
type UpdateThemeInput struct {
	Name   string
	Config []byte
}

// List 返回某人的全部自定义主题。
func (s *ThemeService) List(ctx context.Context, ownerID int64) ([]*domain.Theme, error) {
	themes, err := s.themes.ListByOwner(ctx, ownerID)
	if err != nil {
		return nil, mapThemeError(err)
	}
	return themes, nil
}

// Create 保存一份自定义主题。
func (s *ThemeService) Create(ctx context.Context, ownerID int64, in CreateThemeInput) (*domain.Theme, error) {
	name, err := normalizeThemeName(in.Name)
	if err != nil {
		return nil, err
	}
	count, err := s.themes.CountByOwner(ctx, ownerID)
	if err != nil {
		return nil, mapThemeError(err)
	}
	if count >= int64(s.maxThemes) {
		return nil, apperr.New(apperr.CodeThemeLimitReached, "").
			WithDetail("limit", s.maxThemes)
	}

	uid := id.New()
	config, err := normalizeThemeConfig(uid, name, in.Config)
	if err != nil {
		return nil, err
	}
	created, err := s.themes.Create(ctx, domain.CreateThemeInput{
		UID: uid, OwnerID: ownerID, Name: name,
		Category: domain.ThemeCategoryCustom, Config: config, Now: s.now(),
	})
	if err != nil {
		return nil, mapThemeError(err)
	}
	return created, nil
}

// Update 覆盖一份自定义主题的名字与配置。
//
// 先读再写：仓储的 UPDATE 语句带 `is_builtin = false` 谓词，命中 0 行时
// 只能返回 ErrNotFound——那样「改内置主题」会被报成「主题不存在」。
// 多一次往返换来一个准确的错误码，对低频操作是划算的。
func (s *ThemeService) Update(ctx context.Context, ownerID int64, uid string, in UpdateThemeInput) (*domain.Theme, error) {
	name, err := normalizeThemeName(in.Name)
	if err != nil {
		return nil, err
	}
	existing, err := s.themes.GetByUID(ctx, uid, ownerID)
	if err != nil {
		return nil, mapThemeError(err)
	}
	if existing.IsBuiltin {
		return nil, apperr.New(apperr.CodeThemeBuiltinReadonly, "")
	}
	config, err := normalizeThemeConfig(existing.UID, name, in.Config)
	if err != nil {
		return nil, err
	}
	updated, err := s.themes.Update(ctx, domain.UpdateThemeInput{
		UID: uid, OwnerID: ownerID, Name: name, Config: config, Now: s.now(),
	})
	if err != nil {
		return nil, mapThemeError(err)
	}
	return updated, nil
}

// Delete 删除一份自定义主题。
func (s *ThemeService) Delete(ctx context.Context, ownerID int64, uid string) error {
	existing, err := s.themes.GetByUID(ctx, uid, ownerID)
	if err != nil {
		return mapThemeError(err)
	}
	if existing.IsBuiltin {
		return apperr.New(apperr.CodeThemeBuiltinReadonly, "")
	}
	if err := s.themes.Delete(ctx, uid, ownerID); err != nil {
		return mapThemeError(err)
	}
	return nil
}

// normalizeThemeName 去空白并校验长度。
func normalizeThemeName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	switch {
	case name == "":
		return "", apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"name": "主题名称不能为空",
		})
	case utf8.RuneCountInString(name) > maxThemeNameRunes:
		return "", apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"name": "主题名称最多 64 个字符",
		})
	}
	return name, nil
}

// themeConfigEnvelope 是服务端关心的 Theme 字段。
//
// 只解析「没有它就不是一个主题」的字段，其余原样透传：样式体系归前端所有，
// 服务端多解一层就多一处「后端版本落后于前端」的耦合。
type themeConfigEnvelope struct {
	Palette *struct {
		Colors          []string `json:"colors"`
		LineColors      []string `json:"lineColors"`
		BackgroundColor string   `json:"backgroundColor"`
	} `json:"palette"`
	Global *struct {
		FontFamily string  `json:"fontFamily"`
		FontSize   float64 `json:"fontSize"`
	} `json:"global"`
}

// normalizeThemeConfig 校验配置并把 id / name / category 改写成库里的值。
//
// 为什么必须改写：客户端发上来的是「当前画布的主题」，它的 id 很可能是
// `classic-rainbow`（内置配色的 id）。原样存下去，一份自定义主题就顶着
// 内置主题的 id 出现在列表里，前端按 id 去重时会直接互相覆盖。
func normalizeThemeConfig(uid, name string, raw []byte) ([]byte, error) {
	invalid := func(reason string) error {
		return apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"config": reason,
		})
	}

	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, invalid("缺少主题配置")
	}
	if len(raw) > maxThemeConfigBytes {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"config": "主题配置过大",
		})
	}

	// 用 map 承接而不是结构体：未知字段必须原样留住，否则「前端加一个
	// 样式字段 → 存一次主题 → 字段被后端吃掉」会在用户毫无察觉时丢数据。
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, invalid("主题配置不是合法的 JSON 对象")
	}

	var envelope themeConfigEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, invalid("主题配置字段类型不正确")
	}
	if envelope.Palette == nil || len(envelope.Palette.Colors) == 0 {
		return nil, invalid("缺少调色板颜色")
	}
	for _, color := range append(append([]string{}, envelope.Palette.Colors...), envelope.Palette.LineColors...) {
		if !hexColor.MatchString(color) {
			return nil, invalid("颜色必须是 #RRGGBB 格式")
		}
	}
	if envelope.Global == nil || strings.TrimSpace(envelope.Global.FontFamily) == "" {
		return nil, invalid("缺少全局字体")
	}
	if envelope.Global.FontSize <= 0 {
		return nil, invalid("全局字号必须大于 0")
	}

	for key, value := range map[string]string{
		"id":       uid,
		"name":     name,
		"category": domain.ThemeCategoryCustom,
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		fields[key] = encoded
	}
	return json.Marshal(fields)
}

// mapThemeError 把仓储错误翻译成对外错误码。
func mapThemeError(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return apperr.New(apperr.CodeThemeNotFound, "")
	}
	if errors.Is(err, domain.ErrDuplicate) {
		// uid 是 ULID，撞号意味着熵源出了问题，不是用户能修的事。
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	return err
}
