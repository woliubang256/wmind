package sqlite

import (
	"context"
	"database/sql"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

type LoginChallengeRepository struct{ db *sql.DB }

func NewLoginChallengeRepository(db *sql.DB) *LoginChallengeRepository {
	return &LoginChallengeRepository{db: db}
}

func (r *LoginChallengeRepository) Create(ctx context.Context, v domain.LoginChallenge, now int64) error {
	q := queries(ctx, r.db)
	if err := q.DeleteExpiredLoginChallenges(ctx, now); err != nil {
		return mapSQLiteError(err)
	}
	return mapSQLiteError(q.CreateLoginChallenge(ctx, sqlitedb.CreateLoginChallengeParams{Hash: v.Hash, IdentifierHash: v.IdentifierHash, SealedKey: v.SealedKey, ExpiresAt: v.ExpiresAt}))
}

func (r *LoginChallengeRepository) Consume(ctx context.Context, hash, identifierHash string, now int64) (*domain.LoginChallenge, error) {
	v, err := queries(ctx, r.db).ConsumeLoginChallenge(ctx, sqlitedb.ConsumeLoginChallengeParams{Hash: hash, IdentifierHash: identifierHash, Now: now})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return &domain.LoginChallenge{Hash: v.Hash, IdentifierHash: v.IdentifierHash, SealedKey: v.SealedKey, ExpiresAt: v.ExpiresAt}, nil
}

var _ domain.LoginChallengeRepo = (*LoginChallengeRepository)(nil)
