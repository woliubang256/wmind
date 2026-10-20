package sqlite

import (
	"context"
	"database/sql"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

// TemplateRepository implements domain.TemplateRepo for SQLite.
type TemplateRepository struct{ db *sql.DB }

// NewTemplateRepository 构造 SQLite 模板仓储。
func NewTemplateRepository(db *sql.DB) *TemplateRepository { return &TemplateRepository{db: db} }

func mapSQLiteTemplate(v sqlitedb.Template) (*domain.Template, error) {
	createdAt, err := parseSQLiteTime(v.CreatedAt)
	if err != nil {
		return nil, err
	}
	updatedAt, err := parseSQLiteTime(v.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &domain.Template{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Name: v.Name, Category: v.Category,
		Structure: v.Structure, Document: []byte(v.Document),
		ThumbnailURL: v.ThumbnailUrl,
		// is_builtin 在 SQLite 是 INTEGER，在 PostgreSQL 是 BOOLEAN；
		// 领域层统一成 bool，两种映射各自负责自己的方言。
		IsBuiltin: v.IsBuiltin != 0, SortOrder: int(v.SortOrder),
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}, nil
}

// mapSQLiteTemplateRow 映射列表行。没有 Document：列表查询刻意不选它。
func mapSQLiteTemplateRow(v sqlitedb.ListTemplatesByOwnerRow) (*domain.Template, error) {
	createdAt, err := parseSQLiteTime(v.CreatedAt)
	if err != nil {
		return nil, err
	}
	updatedAt, err := parseSQLiteTime(v.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &domain.Template{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Name: v.Name, Category: v.Category,
		Structure: v.Structure, ThumbnailURL: v.ThumbnailUrl,
		IsBuiltin: v.IsBuiltin != 0, SortOrder: int(v.SortOrder),
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}, nil
}

func (r *TemplateRepository) ListByOwner(ctx context.Context, ownerID int64) ([]*domain.Template, error) {
	rows, err := queries(ctx, r.db).ListTemplatesByOwner(ctx, &ownerID)
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	out := make([]*domain.Template, 0, len(rows))
	for _, row := range rows {
		v, err := mapSQLiteTemplateRow(row)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (r *TemplateRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.Template, error) {
	v, err := queries(ctx, r.db).GetTemplateByUID(ctx, sqlitedb.GetTemplateByUIDParams{Uid: uid, OwnerID: &ownerID})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteTemplate(v)
}

func (r *TemplateRepository) CountByOwner(ctx context.Context, ownerID int64) (int64, error) {
	v, err := queries(ctx, r.db).CountTemplatesByOwner(ctx, &ownerID)
	return v, mapSQLiteError(err)
}

func (r *TemplateRepository) Create(ctx context.Context, in domain.CreateTemplateInput) (*domain.Template, error) {
	v, err := queries(ctx, r.db).CreateTemplate(ctx, sqlitedb.CreateTemplateParams{
		Uid: in.UID, OwnerID: &in.OwnerID, Name: in.Name, Category: in.Category,
		Structure: in.Structure, Document: string(in.Document),
		ThumbnailUrl: in.ThumbnailURL,
		CreatedAt:    sqliteTime(in.Now), UpdatedAt: sqliteTime(in.Now),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteTemplate(v)
}

func (r *TemplateRepository) Rename(ctx context.Context, in domain.RenameTemplateInput) (*domain.Template, error) {
	v, err := queries(ctx, r.db).RenameTemplate(ctx, sqlitedb.RenameTemplateParams{
		Name: in.Name, UpdatedAt: sqliteTime(in.Now),
		Uid: in.UID, OwnerID: &in.OwnerID,
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteTemplate(v)
}

func (r *TemplateRepository) Delete(ctx context.Context, uid string, ownerID int64) error {
	affected, err := queries(ctx, r.db).DeleteTemplate(ctx, sqlitedb.DeleteTemplateParams{Uid: uid, OwnerID: &ownerID})
	return mapSQLiteRowsAffected(affected, err)
}

var _ domain.TemplateRepo = (*TemplateRepository)(nil)
