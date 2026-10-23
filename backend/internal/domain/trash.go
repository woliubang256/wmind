package domain

import (
	"context"
	"time"
)

const DefaultTrashRetentionDays = 30

// TrashRepo is restricted to background retention work, separate from owner-scoped MapRepo.
type TrashRepo interface {
	PurgeExpired(ctx context.Context, cutoff time.Time, batchSize int) (int64, error)
}
