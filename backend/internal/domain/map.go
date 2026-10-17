package domain

import (
	"context"
	"time"
)

// DefaultMapTitle 是新建导图的默认标题。
const DefaultMapTitle = "未命名导图"

// Map 是导图领域模型。
type Map struct {
	ID      int64
	UID     string
	OwnerID int64
	Title   string

	// Document 是完整 .wmind 文档。
	//
	// 统一用 []byte 收发：PostgreSQL 侧是 JSONB、SQLite 侧是 TEXT + json_valid，
	// 但领域层感知不到差异（见 docs/03 §3.5）。
	Document []byte

	// Version 是乐观锁版本号，每次成功保存自增。
	Version int

	ThumbnailURL string
	NodeCount    int
	SizeBytes    int64

	// DeletedAt 非空即表示在回收站里。
	DeletedAt *time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

// IsTrashed 报告该导图是否在回收站中。
func (m *Map) IsTrashed() bool { return m.DeletedAt != nil }

// CreateMapInput 是创建导图的入参。
type CreateMapInput struct {
	UID       string
	OwnerID   int64
	Title     string
	Document  []byte
	NodeCount int
	SizeBytes int64
	Now       time.Time
}

// UpdateMapInput 是保存导图的入参。
//
// ExpectedVersion 是客户端持有的版本号：只有它与库中一致才写入。
// 这是跨请求并发的主要防线；SQLite 侧额外靠 BEGIN IMMEDIATE 兜住同瞬间的并发。
type UpdateMapInput struct {
	UID             string
	OwnerID         int64
	Title           string
	Document        []byte
	ThumbnailURL    string
	NodeCount       int
	SizeBytes       int64
	ExpectedVersion int
	Now             time.Time
}

// MapRepo 是导图仓储接口。
//
// 每个方法都带 ownerID：数据隔离不靠调用方自觉，而是从签名上强制。
// 查不到（含跨用户访问）一律返回 ErrNotFound。
type MapRepo interface {
	Create(ctx context.Context, in CreateMapInput) (*Map, error)

	// GetByUID 按 uid + 属主读取。跨用户访问返回 ErrNotFound，不是「无权限」。
	GetByUID(ctx context.Context, uid string, ownerID int64) (*Map, error)

	// GetForUpdate 在事务内读取并加锁，供保存路径使用。
	//
	// PostgreSQL 实现用 SELECT ... FOR UPDATE；SQLite 实现不加锁（不支持），
	// 改由 BEGIN IMMEDIATE + 单写连接保证串行。方法名保持不变，调用方无感。
	GetForUpdate(ctx context.Context, uid string, ownerID int64) (*Map, error)

	ListByOwner(ctx context.Context, ownerID int64, page Page) ([]*Map, error)
	CountByOwner(ctx context.Context, ownerID int64) (int64, error)

	// SearchByTitle 按标题模糊搜索。pattern 由调用方拼好通配符（如 %关键词%）。
	//
	// 方言差异：PostgreSQL 用 ILIKE（英文大小写不敏感），SQLite 用 LIKE
	// （只对 ASCII 折叠，中文精确匹配）。这是 ADR-015 记录的已知差异。
	SearchByTitle(ctx context.Context, ownerID int64, pattern string, page Page) ([]*Map, error)
	CountByTitle(ctx context.Context, ownerID int64, pattern string) (int64, error)

	// UpdateWithVersion 带乐观锁保存。版本不匹配返回 ErrVersionConflict，
	// 导图不存在返回 ErrNotFound。
	UpdateWithVersion(ctx context.Context, in UpdateMapInput) (*Map, error)

	UpdateMeta(ctx context.Context, uid string, ownerID int64, title string, now time.Time) (*Map, error)
	UpdateThumbnail(ctx context.Context, uid string, ownerID int64, thumbnailURL string, now time.Time) error

	SoftDelete(ctx context.Context, uid string, ownerID int64, now time.Time) error
	Restore(ctx context.Context, uid string, ownerID int64, now time.Time) (*Map, error)
	ListTrashed(ctx context.Context, ownerID int64, page Page) ([]*Map, error)
	CountTrashed(ctx context.Context, ownerID int64) (int64, error)

	// HardDelete 彻底删除单张导图；HardDeleteTrashed 清空回收站。
	HardDelete(ctx context.Context, uid string, ownerID int64) error
	HardDeleteTrashed(ctx context.Context, ownerID int64) error

	// ListAllIncludingDeleted 返回该用户的全部导图（含回收站），
	// 供「删除用户时导出其全部导图」使用。
	ListAllIncludingDeleted(ctx context.Context, ownerID int64) ([]*Map, error)
}
