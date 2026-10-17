// Package domain 定义领域模型与仓储接口。
//
// 它是「双方言不泄漏」的支点：service 与 handler 只依赖本包中的接口，
// **禁止** import repository/postgres 或 repository/sqlite。这条约束有静态检查
// 兜底（见 cmd/dialectcheck），是方言可替换性的机械保障。
//
// 本包不依赖任何其它内部包，也不依赖 gin、sqlc 生成物或数据库驱动。
package domain

import (
	"context"
	"errors"
	"time"
)

// 仓储层向上返回的哨兵错误。
//
// 仓储不构造 apperr——那会把「哪个资源、对应哪个 HTTP 状态」这类业务判断
// 下沉到数据层。仓储只说「没找到 / 冲突了 / 撞唯一约束了」，由 service 决定
// 翻译成哪个错误码。
var (
	// ErrNotFound 表示按条件查不到记录。
	//
	// 注意：跨用户访问也归到这里——「无权访问」对外一律表现为「不存在」，
	// 避免通过状态码差异探测出他人资源的存在性。
	ErrNotFound = errors.New("domain: 资源不存在")

	// ErrVersionConflict 表示乐观锁校验失败（保存时客户端持有的版本已过期）。
	ErrVersionConflict = errors.New("domain: 版本冲突")

	// ErrDuplicate 表示违反唯一约束（邮箱、用户名、分享令牌等）。
	ErrDuplicate = errors.New("domain: 唯一约束冲突")
)

// Page 是分页参数，已归一化为 LIMIT / OFFSET。
type Page struct {
	Limit  int
	Offset int
}

// 分页边界。与 docs/04 §4 的约定一致：page 从 1 开始，page_size 默认 20、最大 100。
const (
	DefaultPageSize = 20
	MaxPageSize     = 100
)

// NewPage 把「第几页、每页多少条」换算成 LIMIT / OFFSET，并夹紧到合法范围。
//
// 夹紧而不是报错：分页参数越界属于调用方的疏忽，返回一个合理的页比返回 422
// 更有用，也避免前端因为多传一个 page_size 就整页失败。
func NewPage(page, pageSize int) Page {
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = DefaultPageSize
	}
	if pageSize > MaxPageSize {
		pageSize = MaxPageSize
	}
	return Page{Limit: pageSize, Offset: (page - 1) * pageSize}
}

// Role 是用户角色。
type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

// Valid 报告角色取值是否合法。
func (r Role) Valid() bool { return r == RoleUser || r == RoleAdmin }

// UserStatus 是用户状态。
type UserStatus string

const (
	UserStatusActive   UserStatus = "active"
	UserStatusDisabled UserStatus = "disabled"
	// UserStatusPending 为二期邮箱验证预留。一期注册即生效，不会写入该值。
	UserStatusPending UserStatus = "pending"
)

// Valid 报告状态取值是否合法。
func (s UserStatus) Valid() bool {
	return s == UserStatusActive || s == UserStatusDisabled || s == UserStatusPending
}

// User 是用户领域模型。
//
// 字段全部是方言无关的 Go 原生类型：仓储实现负责把 pgtype.Timestamptz
// 或 SQLite 的 ISO-8601 字符串转换进来。
type User struct {
	ID           int64
	UID          string
	Username     string
	Email        string
	PasswordHash string
	Nickname     string
	AvatarURL    string
	Role         Role
	Status       UserStatus
	MapCount     int
	LastLoginAt  *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
	DeletedAt    *time.Time
}

// IsAdmin 报告该用户是否为管理员。
func (u *User) IsAdmin() bool { return u.Role == RoleAdmin }

// IsActive 报告该用户是否可登录。
func (u *User) IsActive() bool { return u.Status == UserStatusActive }

// CreateUserInput 是创建用户的入参。
//
// 时间由调用方（service）用 time.Now() 填好——这是「时间不由数据库计算」
// 纪律在类型层面的体现：仓储没有机会偷偷调用 now()。
type CreateUserInput struct {
	UID          string
	Username     string
	Email        string
	PasswordHash string
	Nickname     string
	AvatarURL    string
	Role         Role
	Status       UserStatus
	Now          time.Time
}

// ListUsersInput 是用户列表的筛选条件。空字符串表示不筛选。
type ListUsersInput struct {
	// Keyword 按用户名 / 邮箱 / 昵称模糊匹配，空串表示不筛选。
	Keyword string
	Role    Role
	Status  UserStatus
	Page    Page
}

// UpdateProfileInput 是修改个人资料的入参。
type UpdateProfileInput struct {
	UID       string
	Nickname  string
	AvatarURL string
	Now       time.Time
}

// UserRepo 是用户仓储接口，由两套方言实现各自满足。
type UserRepo interface {
	Create(ctx context.Context, in CreateUserInput) (*User, error)
	GetByID(ctx context.Context, id int64) (*User, error)
	GetByUID(ctx context.Context, uid string) (*User, error)
	GetByEmail(ctx context.Context, email string) (*User, error)
	GetByUsername(ctx context.Context, username string) (*User, error)

	Count(ctx context.Context) (int64, error)
	CountActiveAdmins(ctx context.Context) (int64, error)
	List(ctx context.Context, in ListUsersInput) ([]*User, error)
	CountFiltered(ctx context.Context, in ListUsersInput) (int64, error)

	UpdateProfile(ctx context.Context, in UpdateProfileInput) (*User, error)
	UpdatePassword(ctx context.Context, id int64, passwordHash string, now time.Time) error
	UpdateStatus(ctx context.Context, uid string, status UserStatus, now time.Time) (*User, error)
	UpdateRole(ctx context.Context, uid string, role Role, now time.Time) (*User, error)
	TouchLastLogin(ctx context.Context, id int64, at time.Time) error
	SoftDelete(ctx context.Context, uid string, now time.Time) error
	IncrementMapCount(ctx context.Context, id int64, delta int, now time.Time) error
}
