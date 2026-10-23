package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

type TrashRepository struct{ pool *pgxpool.Pool }

func NewTrashRepository(pool *pgxpool.Pool) *TrashRepository { return &TrashRepository{pool: pool} }

func (r *TrashRepository) PurgeExpired(ctx context.Context, cutoff time.Time, batchSize int) (int64, error) {
	if batchSize <= 0 {
		return 0, nil
	}
	n, err := queries(ctx, r.pool).PurgeExpiredTrash(ctx, pgdb.PurgeExpiredTrashParams{Cutoff: pgTime(cutoff), BatchSize: int32(batchSize)})
	return n, mapPGError(err)
}

var _ domain.TrashRepo = (*TrashRepository)(nil)
