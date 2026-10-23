package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

type AdminStatsRepository struct{ pool *pgxpool.Pool }

func NewAdminStatsRepository(pool *pgxpool.Pool) *AdminStatsRepository {
	return &AdminStatsRepository{pool: pool}
}

func (r *AdminStatsRepository) Read(ctx context.Context, from, until time.Time) (*domain.AdminStats, error) {
	q := queries(ctx, r.pool)
	v, err := q.GetAdminTotals(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := q.ListAdminTrend(ctx, pgdb.ListAdminTrendParams{FromAt: pgTime(from), UntilAt: pgTime(until)})
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
