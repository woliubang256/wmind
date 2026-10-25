package domain

import (
	"context"
	"time"
)

// ShareTokenBytes 是分享令牌的熵（字节）。
//
// 16 字节 = 128 bit，base64url 编码后 22 个字符。令牌**本身就是**访问凭证：
// 拿到 URL 的人就能看导图，所以它的不可枚举性必须由生成方式保证，而不是
// 靠「链接很长没人会猜」。22 个字符的 base64url 空间是 2^128，穷举不成立。
const ShareTokenBytes = 16

// ShareLink 是一条分享链接。
//
// 撤销是软撤销（写 RevokedAt）而不是删行：删了行就丢了访问统计，而「这条
// 链接被看过多少次」恰恰是撤销之后最想知道的事。
type ShareLink struct {
	ID      int64
	UID     string
	Token   string
	MapID   int64
	OwnerID int64

	// PasswordHash 为空串表示无访问密码。
	//
	// bcrypt 独立负责访客验证；可读副本不读入公开查询。
	PasswordHash string `json:"-"`
	// 历史字段名保留：plain: 前缀保存明文访问码，v1: 为旧版 AES-GCM 密文。
	PasswordCiphertext string `json:"-"`
	// Password 仅在属主服务返回值内存中填充，不回写这一派生字段。
	// nil 表示未设密码、旧哈希或旧密文不可解密，HasPassword 仍由哈希决定。
	Password *string `json:"-"`

	AllowDownload bool
	ShowNotes     bool

	// ExpiresAt 为 nil 表示永久有效。
	ExpiresAt *time.Time

	ViewCount    int
	LastViewedAt *time.Time
	RevokedAt    *time.Time
	CreatedAt    time.Time

	// MapUID / MapTitle 来自查询里的 JOIN。
	//
	// 它们不是 share_links 的列，但每一处会展示分享的地方都要显示导图标题
	// ——「我的分享」列表如果只有一串随机令牌就完全没法用。放在这里而不是
	// 让调用方再查一次，是为了避免列表页的 N+1。
	MapUID   string
	MapTitle string
}

// HasPassword 报告该链接是否需要访问密码。
func (l *ShareLink) HasPassword() bool { return l.PasswordHash != "" }

// Revoked 报告该链接是否已被撤销。
func (l *ShareLink) Revoked() bool { return l.RevokedAt != nil }

// Expired 报告在给定时刻是否已过期。
//
// 时刻由调用方传入而不是内部取 time.Now()：测试需要把「过期」从真实时间上
// 解耦，否则只能 sleep。
func (l *ShareLink) Expired(at time.Time) bool {
	return l.ExpiresAt != nil && !at.Before(*l.ExpiresAt)
}

// Usable 报告链接在给定时刻是否还能打开（未撤销且未过期）。
//
// 它**不**判断导图是否已删除、站点是否关闭分享——那两件事不在这一行数据
// 里，由 service 层合并判断。
func (l *ShareLink) Usable(at time.Time) bool { return !l.Revoked() && !l.Expired(at) }

// ShareDocument 是公开读取的结果：分享本身 + 它指向的导图内容。
//
// 单独一个类型而不是给 ShareLink 加 Document 字段：文档可能有 8 MiB，把它
// 挂在 ShareLink 上意味着每一次「我的分享」列表查询都在内存里拖着几十份
// 文档，而那个页面一份都不需要。
type ShareDocument struct {
	Share *ShareLink

	// Document 是完整 .wmind 文档，尚未剥离备注与内部字段。
	// 剥离由 service 层做（见 service.ShareService.ReadPublic）。
	Document []byte

	// MapDeleted 表示导图在回收站里。
	//
	// 分享链接不随软删除一起失效（恢复导图后链接应当还能用），但打开时
	// 必须与「已撤销」返回同一个 404，否则「这张图存在过」就成了可探测的
	// 信息。
	MapDeleted bool

	// OwnerNickname 是分享者的昵称，分享页上作为出处显示。
	//
	// 只有昵称：uid 与邮箱不出现在公开响应里（docs/04 §5.7）。这一列由
	// 查询直接 JOIN 出来，不读 uid / email 就不会因为以后改 DTO 而漏出去。
	OwnerNickname string
}

// CreateShareInput 是创建分享链接的入参。
type CreateShareInput struct {
	UID                string
	Token              string
	MapID              int64
	OwnerID            int64
	PasswordHash       string
	PasswordCiphertext string
	AllowDownload      bool
	ShowNotes          bool
	ExpiresAt          *time.Time
	Now                time.Time
}

// UpdateShareInput 是改写分享设置的入参。
//
// 每个字段都是「合并后的最终值」，不是补丁：仓储只做一次全量写入
// （原因见 queries/shared/shares.sql 里 UpdateShare 的注释）。
type UpdateShareInput struct {
	UID          string
	OwnerID      int64
	PasswordHash string
	// ExpectedPasswordHash prevents a delayed settings write from restoring an old password.
	ExpectedPasswordHash string
	PasswordCiphertext   string
	AllowDownload        bool
	ShowNotes            bool
	ExpiresAt            *time.Time
}

// ShareRepo 是分享链接仓储接口。
//
// 属主类方法都带 ownerID：越权访问返回 ErrNotFound，不是「无权限」。
// GetByToken 是唯一的匿名入口，不接收 ownerID，但只读取启用且未删除属主的分享。
type ShareRepo interface {
	Create(ctx context.Context, in CreateShareInput) (*ShareLink, error)

	// GetByUID 按 uid + 属主读取（管理用）。
	GetByUID(ctx context.Context, uid string, ownerID int64) (*ShareLink, error)

	// GetByToken 按令牌读取，同时带出导图内容（公开访问用）。
	GetByToken(ctx context.Context, token string) (*ShareDocument, error)

	// ListByMap 返回某张导图的全部链接（含已撤销的，按创建时间倒序）。
	ListByMap(ctx context.Context, mapID int64, ownerID int64) ([]*ShareLink, error)

	// ListByOwner 返回某人创建的全部链接；mapUID 非空时只返回该导图的。
	ListByOwner(ctx context.Context, ownerID int64, mapUID string, page Page) ([]*ShareLink, error)
	CountByOwner(ctx context.Context, ownerID int64, mapUID string) (int64, error)

	// CountActiveByMap 统计仍然有效的链接数（用于配额）。
	CountActiveByMap(ctx context.Context, mapID int64) (int64, error)

	// Update 全量改写设置。已撤销的链接不可改写，返回 ErrNotFound。
	Update(ctx context.Context, in UpdateShareInput) (*ShareLink, error)

	// Revoke 撤销链接。已经撤销过的返回 ErrNotFound（幂等语义由调用方表达）。
	Revoke(ctx context.Context, uid string, ownerID int64, now time.Time) error

	// RecordView 把访问计数加一并记下时间。
	RecordView(ctx context.Context, id int64, at time.Time) error
}
