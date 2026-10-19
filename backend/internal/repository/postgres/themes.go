package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

// ThemeRepository implements domain.ThemeRepo for PostgreSQL.
type ThemeRepository struct {
	pool *pgxpool.Pool
}

// NewThemeRepository 构造 PostgreSQL 主题仓储。
func NewThemeRepository(pool *pgxpool.Pool) *ThemeRepository { return &ThemeRepository{pool: pool} }

func (r *ThemeRepository) queries(ctx context.Context) *pgdb.Queries {
	return queries(ctx, r.pool)
}

func mapPGTheme(v pgdb.Theme) *domain.Theme {
	return &domain.Theme{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Name: v.Name, Category: v.Category,
		// 复制一份：pgx 的 []byte 可能指向连接缓冲区，被下一次查询覆写。
		Config:    append([]byte(nil), v.Config...),
		IsBuiltin: v.IsBuiltin, SortOrder: int(v.SortOrder),
		CreatedAt: v.CreatedAt.Time.UTC(), UpdatedAt: v.UpdatedAt.Time.UTC(),
	}
}

func (r *ThemeRepository) ListByOwner(ctx context.Context, ownerID int64) ([]*domain.Theme, error) {
	rows, err := r.queries(ctx).ListThemesByOwner(ctx, &ownerID)
	if err != nil {
		return nil, mapPGError(err)
	}
	out := make([]*domain.Theme, 0, len(rows))
	for _, row := range rows {
		out = append(out, mapPGTheme(row))
	}
	return out, nil
}

func (r *ThemeRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.Theme, error) {
	v, err := r.queries(ctx).GetThemeByUID(ctx, pgdb.GetThemeByUIDParams{Uid: uid, OwnerID: &ownerID})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGTheme(v), nil
}

func (r *ThemeRepository) CountByOwner(ctx context.Context, ownerID int64) (int64, error) {
	v, err := r.queries(ctx).CountThemesByOwner(ctx, &ownerID)
	return v, mapPGError(err)
}

func (r *ThemeRepository) Create(ctx context.Context, in domain.CreateThemeInput) (*domain.Theme, error) {
	v, err := r.queries(ctx).CreateTheme(ctx, pgdb.CreateThemeParams{
		Uid: in.UID, OwnerID: &in.OwnerID, Name: in.Name, Category: in.Category,
		Config: in.Config, CreatedAt: pgTime(in.Now), UpdatedAt: pgTime(in.Now),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGTheme(v), nil
}

func (r *ThemeRepository) Update(ctx context.Context, in domain.UpdateThemeInput) (*domain.Theme, error) {
	v, err := r.queries(ctx).UpdateTheme(ctx, pgdb.UpdateThemeParams{
		Name: in.Name, Config: in.Config, UpdatedAt: pgTime(in.Now),
		Uid: in.UID, OwnerID: &in.OwnerID,
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGTheme(v), nil
}

func (r *ThemeRepository) Delete(ctx context.Context, uid string, ownerID int64) error {
	affected, err := r.queries(ctx).DeleteTheme(ctx, pgdb.DeleteThemeParams{Uid: uid, OwnerID: &ownerID})
	return mapPGRowsAffected(affected, err)
}

var _ domain.ThemeRepo = (*ThemeRepository)(nil)
