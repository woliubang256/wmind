package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

type LoginChallengeRepository struct{ pool *pgxpool.Pool }

func NewLoginChallengeRepository(pool *pgxpool.Pool) *LoginChallengeRepository {
	return &LoginChallengeRepository{pool: pool}
}

func (r *LoginChallengeRepository) Create(ctx context.Context, v domain.LoginChallenge, now int64) error {
	q := queries(ctx, r.pool)
	if err := q.DeleteExpiredLoginChallenges(ctx, now); err != nil {
		return mapPGError(err)
	}
	return mapPGError(q.CreateLoginChallenge(ctx, pgdb.CreateLoginChallengeParams{Hash: v.Hash, IdentifierHash: v.IdentifierHash, SealedKey: v.SealedKey, ExpiresAt: v.ExpiresAt}))
}

func (r *LoginChallengeRepository) Consume(ctx context.Context, hash, identifierHash string, now int64) (*domain.LoginChallenge, error) {
	v, err := queries(ctx, r.pool).ConsumeLoginChallenge(ctx, pgdb.ConsumeLoginChallengeParams{Hash: hash, IdentifierHash: identifierHash, Now: now})
	if err != nil {
		return nil, mapPGError(err)
	}
	return &domain.LoginChallenge{Hash: v.Hash, IdentifierHash: v.IdentifierHash, SealedKey: v.SealedKey, ExpiresAt: v.ExpiresAt}, nil
}

var _ domain.LoginChallengeRepo = (*LoginChallengeRepository)(nil)
