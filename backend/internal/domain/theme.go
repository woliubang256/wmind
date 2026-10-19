package domain

import (
	"context"
	"time"
)

// ThemeCategoryCustom 是用户自建主题的分类。
//
// 内置配色的分类是 vivid / classic（见 docs/03 §6.2），用户主题一律 custom。
// 单独列成常量而不是散落字符串：前端按分类分组渲染，拼错一个字母就会
// 让主题「凭空消失」到未知分组里。
const ThemeCategoryCustom = "custom"

// Theme 是一条用户自定义主题。
//
// Config 是完整的 Theme 对象（docs/03 §2.5）的原始 JSON，与 domain.Map.Document
// 同一套理由：服务端只做「是不是一个像样的主题」的体检，不把样式体系
// 反序列化成强类型——那会让「前端加一个样式字段」变成「后端发一次版」。
//
// 内置的 10 套配色**不在**这张表里：它们是前端包内的静态资源
// （frontend/src/editor/theme/palettes.json）。编辑器首帧就要解析样式，
// 不能等一个请求回来。OwnerID 与 IsBuiltin 因此在一期恒为「有主 / 非内置」，
// 保留字段是给二期「管理员维护内置主题」留的口子。
type Theme struct {
	ID      int64
	UID     string
	OwnerID *int64
	Name    string
	// Category 一期恒为 ThemeCategoryCustom。
	Category string
	// Config 是 Theme 对象的 JSON。
	Config    []byte
	IsBuiltin bool
	SortOrder int

	CreatedAt time.Time
	UpdatedAt time.Time
}

// CreateThemeInput 是创建自定义主题的入参。
type CreateThemeInput struct {
	UID      string
	OwnerID  int64
	Name     string
	Category string
	Config   []byte
	Now      time.Time
}

// UpdateThemeInput 是更新自定义主题的入参。
//
// 没有 ExpectedVersion：主题是单人编辑的轻量配置，冲突的代价只是「覆盖了
// 自己在另一台设备上改的一个颜色」，不值得为它引入一套版本握手。
type UpdateThemeInput struct {
	UID     string
	OwnerID int64
	Name    string
	Config  []byte
	Now     time.Time
}

// ThemeRepo 是自定义主题仓储接口。
//
// 与 MapRepo 同样的约定：每个方法都带 ownerID，查不到（含跨用户访问）
// 一律返回 ErrNotFound，而不是「无权限」——后者会泄露「这个 uid 存在」。
type ThemeRepo interface {
	ListByOwner(ctx context.Context, ownerID int64) ([]*Theme, error)
	GetByUID(ctx context.Context, uid string, ownerID int64) (*Theme, error)
	CountByOwner(ctx context.Context, ownerID int64) (int64, error)
	Create(ctx context.Context, in CreateThemeInput) (*Theme, error)
	Update(ctx context.Context, in UpdateThemeInput) (*Theme, error)
	Delete(ctx context.Context, uid string, ownerID int64) error
}
