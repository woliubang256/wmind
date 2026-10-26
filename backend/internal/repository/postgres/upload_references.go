package postgres

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

type UploadReferencesRepository struct{ db *pgxpool.Pool }

func NewUploadReferencesRepository(db *pgxpool.Pool) *UploadReferencesRepository {
	return &UploadReferencesRepository{db: db}
}
func (r *UploadReferencesRepository) VisitUploadReferences(ctx context.Context, visit func(domain.UploadReference) error) error {
	q := queries(ctx, r.db)
	var cursor int64
	for {
		rows, err := q.ListUploadMapReferences(ctx, cursor)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if err := visit(domain.UploadReference{URL: row.ThumbnailUrl, Document: []byte(row.Document)}); err != nil {
				return err
			}
			cursor = row.ID
		}
		if len(rows) < 100 {
			break
		}
	}
	cursor = 0
	for {
		rows, err := q.ListUploadTemplateReferences(ctx, cursor)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if err := visit(domain.UploadReference{URL: row.ThumbnailUrl, Document: []byte(row.Document)}); err != nil {
				return err
			}
			cursor = row.ID
		}
		if len(rows) < 100 {
			break
		}
	}
	cursor = 0
	for {
		rows, err := q.ListUploadAvatarReferences(ctx, cursor)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if err := visit(domain.UploadReference{URL: row.AvatarUrl}); err != nil {
				return err
			}
			cursor = row.ID
		}
		if len(rows) < 100 {
			break
		}
	}
	settings, err := q.ListSettings(ctx)
	if err != nil {
		return err
	}
	for _, row := range settings {
		if err := visit(domain.UploadReference{Setting: []byte(row.Value)}); err != nil {
			return err
		}
	}
	return nil
}

var _ domain.UploadReferencesRepo = (*UploadReferencesRepository)(nil)
