package domain

import (
	"context"
	"time"
)

// TemplateCategoryUser 是用户自建模板的分类。
//
// 内置模板的分类是 basic（见 docs/03 §2.6），用户模板一律 user。与
// ThemeCategoryCustom 同样的理由：前端按分类分组渲染，拼错一个字母就会让
// 模板「凭空消失」到未知分组里。
const TemplateCategoryUser = "user"

// Template 是一条用户模板。
//
// Document 是完整 .wmind 文档的原始 JSON，与 Map.Document 同一套理由：
// 服务端只做「是不是一份像样的文档」的体检，不把它反序列化成强类型——
// 那会让「前端给 Topic 加一个字段」变成「后端发一次版」。
//
// **列表查询不填 Document**（见 ListByOwner 的注释）：一份文档可能到 8 MiB，
// 而列表只需要名字、结构与缩略图。只有 GetByUID 会带上它。
//
// 内置的 8 个模板**不在**这张表里：它们编译进前端包
// （frontend/src/features/templates/builtin.ts）。三条理由见
// db/queries/shared/templates.sql 的文件头。OwnerID 与 IsBuiltin 因此在一期
// 恒为「有主 / 非内置」，保留字段是给二期「管理员维护内置模板」留的口子。
type Template struct {
	ID      int64
	UID     string
	OwnerID *int64
	Name    string
	// Category 一期恒为 TemplateCategoryUser。
	Category string
	// Structure 是模板默认结构（mindmap / logic-right / ...）。
	//
	// 它同时冗余在 Document.sheets[0].structure 里。留着这一列是因为列表
	// 页要按结构分组/筛选，而为了拿到一个字符串去解一份完整文档不值得。
	Structure string
	// Document 是 .wmind 文档的 JSON。列表查询下为 nil。
	Document []byte
	// ThumbnailURL 是「另存为模板」那一刻源导图的缩略图，站内相对路径。
	// 为空表示源图从未在编辑器里打开过，前端退化成结构图标。
	ThumbnailURL string
	IsBuiltin    bool
	SortOrder    int

	CreatedAt time.Time
	UpdatedAt time.Time
}

// CreateTemplateInput 是创建用户模板的入参。
type CreateTemplateInput struct {
	UID          string
	OwnerID      int64
	Name         string
	Category     string
	Structure    string
	Document     []byte
	ThumbnailURL string
	Now          time.Time
}

// RenameTemplateInput 是重命名用户模板的入参。
//
// 只有名字：模板的文档是「另存为那一刻的快照」，允许事后改内容会让「我的
// 模板」变成第二个编辑器，而它的用途恰恰是「一个不再变动的起点」。
type RenameTemplateInput struct {
	UID     string
	OwnerID int64
	Name    string
	Now     time.Time
}

// TemplateRepo 是用户模板仓储接口。
//
// 与 MapRepo / ThemeRepo 同样的约定：每个方法都带 ownerID，查不到
// （含跨用户访问）一律返回 ErrNotFound，而不是「无权限」——后者会泄露
// 「这个 uid 存在」。
type TemplateRepo interface {
	ListByOwner(ctx context.Context, ownerID int64) ([]*Template, error)
	GetByUID(ctx context.Context, uid string, ownerID int64) (*Template, error)
	CountByOwner(ctx context.Context, ownerID int64) (int64, error)
	Create(ctx context.Context, in CreateTemplateInput) (*Template, error)
	Rename(ctx context.Context, in RenameTemplateInput) (*Template, error)
	Delete(ctx context.Context, uid string, ownerID int64) error
}
