package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

type TwoFactorRepository struct{ db *sql.DB }

func NewTwoFactorRepository(conn *sql.DB) *TwoFactorRepository { return &TwoFactorRepository{db: conn} }
func (r *TwoFactorRepository) Ensure(ctx context.Context, userID int64) error {
	return mapSQLiteError(queries(ctx, r.db).EnsureTwoFactor(ctx, userID))
}
func (r *TwoFactorRepository) Get(ctx context.Context, userID int64, lock bool) (*domain.TwoFactorState, error) {
	q := queries(ctx, r.db)
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
	if errors.Is(mapSQLiteError(err), domain.ErrNotFound) && !lock {
		return &domain.TwoFactorState{}, nil
	}
	if err != nil {
		return nil, mapSQLiteError(err)
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
	n, err := queries(ctx, r.db).SaveTwoFactor(ctx, sqlitedb.SaveTwoFactorParams{UserID: userID, State: string(data), Revision: state.Revision})
	if err != nil {
		return mapSQLiteError(err)
	}
	if n != 1 {
		return domain.ErrVersionConflict
	}
	state.Revision++
	return nil
}

var _ domain.TwoFactorRepo = (*TwoFactorRepository)(nil)
