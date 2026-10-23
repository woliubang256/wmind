package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

type AdminStatsRepository struct{ db *sql.DB }

func NewAdminStatsRepository(db *sql.DB) *AdminStatsRepository { return &AdminStatsRepository{db: db} }

func (r *AdminStatsRepository) Read(ctx context.Context, from, until time.Time) (*domain.AdminStats, error) {
	q := queries(ctx, r.db)
	v, err := q.GetAdminTotals(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListAdminTrend(ctx, sqlitedb.ListAdminTrendParams{FromAt: sqliteTime(from), UntilAt: sqliteTime(until)})
	if err != nil {
		return nil, err
	}
	stats := &domain.AdminStats{UserCount: v.UserCount, ActiveUserCount: v.ActiveUserCount, MapCount: v.MapCount, StorageUsedBytes: v.StorageUsedBytes, Trend: make([]domain.AdminTrendPoint, 0, len(rows))}
	for _, row := range rows {
		stats.Trend = append(stats.Trend, domain.AdminTrendPoint{Date: row.Day, NewUsers: row.NewUsers, NewMaps: row.NewMaps})
	}
	return stats, nil
}

var _ domain.AdminStatsRepo = (*AdminStatsRepository)(nil)
