package sqlite

import (
	"context"
	"database/sql"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

// ThemeRepository implements domain.ThemeRepo for SQLite.
type ThemeRepository struct{ db *sql.DB }

// NewThemeRepository 构造 SQLite 主题仓储。
func NewThemeRepository(db *sql.DB) *ThemeRepository { return &ThemeRepository{db: db} }

func mapSQLiteTheme(v sqlitedb.Theme) (*domain.Theme, error) {
	createdAt, err := parseSQLiteTime(v.CreatedAt)
	if err != nil {
		return nil, err
	}
	updatedAt, err := parseSQLiteTime(v.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &domain.Theme{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Name: v.Name, Category: v.Category,
		Config: []byte(v.Config),
		// is_builtin 在 SQLite 是 INTEGER，在 PostgreSQL 是 BOOLEAN；
		// 领域层统一成 bool，两种映射各自负责自己的方言。
		IsBuiltin: v.IsBuiltin != 0, SortOrder: int(v.SortOrder),
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}, nil
}

func (r *ThemeRepository) ListByOwner(ctx context.Context, ownerID int64) ([]*domain.Theme, error) {
	rows, err := queries(ctx, r.db).ListThemesByOwner(ctx, &ownerID)
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	out := make([]*domain.Theme, 0, len(rows))
	for _, row := range rows {
		v, err := mapSQLiteTheme(row)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (r *ThemeRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.Theme, error) {
	v, err := queries(ctx, r.db).GetThemeByUID(ctx, sqlitedb.GetThemeByUIDParams{Uid: uid, OwnerID: &ownerID})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteTheme(v)
}

func (r *ThemeRepository) CountByOwner(ctx context.Context, ownerID int64) (int64, error) {
	v, err := queries(ctx, r.db).CountThemesByOwner(ctx, &ownerID)
	return v, mapSQLiteError(err)
}

func (r *ThemeRepository) Create(ctx context.Context, in domain.CreateThemeInput) (*domain.Theme, error) {
	v, err := queries(ctx, r.db).CreateTheme(ctx, sqlitedb.CreateThemeParams{
		Uid: in.UID, OwnerID: &in.OwnerID, Name: in.Name, Category: in.Category,
		Config: string(in.Config), CreatedAt: sqliteTime(in.Now), UpdatedAt: sqliteTime(in.Now),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteTheme(v)
}

func (r *ThemeRepository) Update(ctx context.Context, in domain.UpdateThemeInput) (*domain.Theme, error) {
	v, err := queries(ctx, r.db).UpdateTheme(ctx, sqlitedb.UpdateThemeParams{
		Name: in.Name, Config: string(in.Config), UpdatedAt: sqliteTime(in.Now),
		Uid: in.UID, OwnerID: &in.OwnerID,
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteTheme(v)
}

func (r *ThemeRepository) Delete(ctx context.Context, uid string, ownerID int64) error {
	affected, err := queries(ctx, r.db).DeleteTheme(ctx, sqlitedb.DeleteThemeParams{Uid: uid, OwnerID: &ownerID})
	return mapSQLiteRowsAffected(affected, err)
}

var _ domain.ThemeRepo = (*ThemeRepository)(nil)
