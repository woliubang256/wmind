package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

type TwoFactorRepository struct{ pool *pgxpool.Pool }

func NewTwoFactorRepository(conn *pgxpool.Pool) *TwoFactorRepository {
	return &TwoFactorRepository{pool: conn}
}
func (r *TwoFactorRepository) Ensure(ctx context.Context, userID int64) error {
	return mapPGError(queries(ctx, r.pool).EnsureTwoFactor(ctx, userID))
}
func (r *TwoFactorRepository) Get(ctx context.Context, userID int64, lock bool) (*domain.TwoFactorState, error) {
	q := queries(ctx, r.pool)
	var state string
	var revision int64
	var err error
	if lock {
		v, e := q.GetTwoFactorForUpdate(ctx, userID)
		state, revision, err = v.State, v.Revision, e
	} else {
		v, e := q.GetTwoFactor(ctx, userID)
		state, revision, err = v.State, v.Revision, e
	}
	if errors.Is(mapPGError(err), domain.ErrNotFound) && !lock {
		return &domain.TwoFactorState{}, nil
	}
	if err != nil {
		return nil, mapPGError(err)
	}
	var out domain.TwoFactorState
	if err := json.Unmarshal([]byte(state), &out); err != nil {
		return nil, err
	}
	out.Revision = revision
	return &out, nil
}
func (r *TwoFactorRepository) Save(ctx context.Context, userID int64, state *domain.TwoFactorState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	n, err := queries(ctx, r.pool).SaveTwoFactor(ctx, pgdb.SaveTwoFactorParams{UserID: userID, State: string(data), Revision: state.Revision})
	if err != nil {
		return mapPGError(err)
	}
	if n != 1 {
		return domain.ErrVersionConflict
	}
	state.Revision++
	return nil
}

var _ domain.TwoFactorRepo = (*TwoFactorRepository)(nil)
