package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

type TrashRepository struct{ db *sql.DB }

func NewTrashRepository(db *sql.DB) *TrashRepository { return &TrashRepository{db: db} }

func (r *TrashRepository) PurgeExpired(ctx context.Context, cutoff time.Time, batchSize int) (int64, error) {
	if batchSize <= 0 {
		return 0, nil
	}
	at := sqliteTime(cutoff)
	n, err := queries(ctx, r.db).PurgeExpiredTrash(ctx, sqlitedb.PurgeExpiredTrashParams{Cutoff: &at, BatchSize: int64(batchSize)})
	return n, mapSQLiteError(err)
}

var _ domain.TrashRepo = (*TrashRepository)(nil)
