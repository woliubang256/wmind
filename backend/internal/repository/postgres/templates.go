package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

// TemplateRepository implements domain.TemplateRepo for PostgreSQL.
type TemplateRepository struct {
	pool *pgxpool.Pool
}

// NewTemplateRepository 构造 PostgreSQL 模板仓储。
func NewTemplateRepository(pool *pgxpool.Pool) *TemplateRepository {
	return &TemplateRepository{pool: pool}
}

func (r *TemplateRepository) queries(ctx context.Context) *pgdb.Queries {
	return queries(ctx, r.pool)
}

func mapPGTemplate(v pgdb.Template) *domain.Template {
	return &domain.Template{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Name: v.Name, Category: v.Category,
		Structure: v.Structure,
		// 复制一份：pgx 的 []byte 可能指向连接缓冲区，被下一次查询覆写。
		Document:     append([]byte(nil), v.Document...),
		ThumbnailURL: v.ThumbnailUrl,
		IsBuiltin:    v.IsBuiltin, SortOrder: int(v.SortOrder),
		CreatedAt: v.CreatedAt.Time.UTC(), UpdatedAt: v.UpdatedAt.Time.UTC(),
	}
}

// mapPGTemplateRow 映射列表行。没有 Document：列表查询刻意不选它。
func mapPGTemplateRow(v pgdb.ListTemplatesByOwnerRow) *domain.Template {
	return &domain.Template{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Name: v.Name, Category: v.Category,
		Structure: v.Structure, ThumbnailURL: v.ThumbnailUrl,
		IsBuiltin: v.IsBuiltin, SortOrder: int(v.SortOrder),
		CreatedAt: v.CreatedAt.Time.UTC(), UpdatedAt: v.UpdatedAt.Time.UTC(),
	}
}

func (r *TemplateRepository) ListByOwner(ctx context.Context, ownerID int64) ([]*domain.Template, error) {
	rows, err := r.queries(ctx).ListTemplatesByOwner(ctx, &ownerID)
	if err != nil {
		return nil, mapPGError(err)
	}
	out := make([]*domain.Template, 0, len(rows))
	for _, row := range rows {
		out = append(out, mapPGTemplateRow(row))
	}
	return out, nil
}

func (r *TemplateRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.Template, error) {
	v, err := r.queries(ctx).GetTemplateByUID(ctx, pgdb.GetTemplateByUIDParams{Uid: uid, OwnerID: &ownerID})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGTemplate(v), nil
}

func (r *TemplateRepository) CountByOwner(ctx context.Context, ownerID int64) (int64, error) {
	v, err := r.queries(ctx).CountTemplatesByOwner(ctx, &ownerID)
	return v, mapPGError(err)
}

func (r *TemplateRepository) Create(ctx context.Context, in domain.CreateTemplateInput) (*domain.Template, error) {
	v, err := r.queries(ctx).CreateTemplate(ctx, pgdb.CreateTemplateParams{
		Uid: in.UID, OwnerID: &in.OwnerID, Name: in.Name, Category: in.Category,
		Structure: in.Structure, Document: in.Document,
		ThumbnailUrl: in.ThumbnailURL,
		CreatedAt:    pgTime(in.Now), UpdatedAt: pgTime(in.Now),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGTemplate(v), nil
}

func (r *TemplateRepository) Rename(ctx context.Context, in domain.RenameTemplateInput) (*domain.Template, error) {
	v, err := r.queries(ctx).RenameTemplate(ctx, pgdb.RenameTemplateParams{
		Name: in.Name, UpdatedAt: pgTime(in.Now),
		Uid: in.UID, OwnerID: &in.OwnerID,
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGTemplate(v), nil
}

func (r *TemplateRepository) Delete(ctx context.Context, uid string, ownerID int64) error {
	affected, err := r.queries(ctx).DeleteTemplate(ctx, pgdb.DeleteTemplateParams{Uid: uid, OwnerID: &ownerID})
	return mapPGRowsAffected(affected, err)
}

var _ domain.TemplateRepo = (*TemplateRepository)(nil)
