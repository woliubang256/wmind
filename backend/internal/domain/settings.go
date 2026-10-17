package domain

import (
	"context"
	"time"
)

// Setting 是一条站点设置。
//
// Value 是原始 JSON 文本而不是解析后的结构：键的语义属于 service 层，
// 仓储只负责「按 key 存取一段 JSON」。这样新增一个设置项不需要改仓储，
// 也不需要改两套迁移。
type Setting struct {
	Key       string
	Value     string
	UpdatedBy *int64
	UpdatedAt time.Time
}

// SettingsRepo 是站点设置仓储接口。
//
// 没有 Get(key)：读路径是「一次全量加载 + 内存快照」（docs/04 §7.5），
// 逐键查询会把快照退化成 N 次往返。写路径只有 Upsert。
type SettingsRepo interface {
	List(ctx context.Context) ([]*Setting, error)
	Upsert(ctx context.Context, key, value string, updatedBy *int64, now time.Time) error
}
