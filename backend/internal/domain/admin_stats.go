package domain

import (
	"context"
	"time"
)

type AdminTrendPoint struct {
	Date     string `json:"date"`
	NewUsers int64  `json:"newUsers"`
	NewMaps  int64  `json:"newMaps"`
}

// AdminStats 的存储量是文档与上传文件的业务字节数，不是数据库物理大小。
type AdminStats struct {
	UserCount        int64             `json:"userCount"`
	ActiveUserCount  int64             `json:"activeUserCount"`
	MapCount         int64             `json:"mapCount"`
	MapCountToday    int64             `json:"mapCountToday"`
	StorageUsedBytes int64             `json:"storageUsedBytes"`
	Trend            []AdminTrendPoint `json:"trend"`
}

// AdminStatsRepo 专供管理员聚合，不放宽带 ownerID 的普通导图仓储接口。
type AdminStatsRepo interface {
	Read(ctx context.Context, from, until time.Time) (*AdminStats, error)
}
