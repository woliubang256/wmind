package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

// RefreshTokenRepository implements domain.RefreshTokenRepo for SQLite.
type RefreshTokenRepository struct{ db *sql.DB }

// SettingsRepository implements domain.SettingsRepo for SQLite.
type SettingsRepository struct{ db *sql.DB }

// AuditRepository implements domain.AuditRepo for SQLite.
type AuditRepository struct{ db *sql.DB }

func NewRefreshTokenRepository(db *sql.DB) *RefreshTokenRepository {
	return &RefreshTokenRepository{db: db}
}

func NewSettingsRepository(db *sql.DB) *SettingsRepository {
	return &SettingsRepository{db: db}
}

func NewAuditRepository(db *sql.DB) *AuditRepository {
	return &AuditRepository{db: db}
}

func mapSQLiteRefreshToken(v sqlitedb.RefreshToken) (*domain.RefreshToken, error) {
	expiresAt, err := parseSQLiteTime(v.ExpiresAt)
	if err != nil {
		return nil, err
	}
	createdAt, err := parseSQLiteTime(v.CreatedAt)
	if err != nil {
		return nil, err
	}
	revokedAt, err := parseSQLiteTimePtr(v.RevokedAt)
	if err != nil {
		return nil, err
	}
	return &domain.RefreshToken{
		ID: v.ID, UserID: v.UserID, TokenHash: v.TokenHash, Platform: v.Platform,
		Device: v.Device, ExpiresAt: expiresAt, RevokedAt: revokedAt, CreatedAt: createdAt,
	}, nil
}

func (r *RefreshTokenRepository) Create(ctx context.Context, in domain.CreateRefreshTokenInput) (*domain.RefreshToken, error) {
	v, err := queries(ctx, r.db).CreateRefreshToken(ctx, sqlitedb.CreateRefreshTokenParams{
		UserID: in.UserID, TokenHash: in.TokenHash, Platform: in.Platform,
		Device: in.Device, ExpiresAt: sqliteTime(in.ExpiresAt), CreatedAt: sqliteTime(in.Now),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteRefreshToken(v)
}

func (r *RefreshTokenRepository) GetByHash(ctx context.Context, tokenHash string) (*domain.RefreshToken, error) {
	v, err := queries(ctx, r.db).GetRefreshTokenByHash(ctx, tokenHash)
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteRefreshToken(v)
}

func (r *RefreshTokenRepository) Revoke(ctx context.Context, tokenHash string, at time.Time) (bool, error) {
	revokedAt := sqliteTime(at)
	affected, err := queries(ctx, r.db).RevokeRefreshToken(ctx, sqlitedb.RevokeRefreshTokenParams{
		RevokedAt: &revokedAt, TokenHash: tokenHash,
	})
	if err != nil {
		return false, mapSQLiteError(err)
	}
	return affected > 0, nil
}

func (r *RefreshTokenRepository) RevokeAllForUser(ctx context.Context, userID int64, at time.Time) (int64, error) {
	revokedAt := sqliteTime(at)
	affected, err := queries(ctx, r.db).RevokeUserRefreshTokens(ctx, sqlitedb.RevokeUserRefreshTokensParams{
		RevokedAt: &revokedAt, UserID: userID,
	})
	return affected, mapSQLiteError(err)
}

func (r *RefreshTokenRepository) RevokeAllExcept(ctx context.Context, userID int64, keepTokenHash string, at time.Time) (int64, error) {
	revokedAt := sqliteTime(at)
	affected, err := queries(ctx, r.db).RevokeUserRefreshTokensExcept(ctx, sqlitedb.RevokeUserRefreshTokensExceptParams{
		RevokedAt: &revokedAt, UserID: userID, KeepTokenHash: keepTokenHash,
	})
	return affected, mapSQLiteError(err)
}

func (r *RefreshTokenRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	affected, err := queries(ctx, r.db).DeleteExpiredRefreshTokens(ctx, sqliteTime(before))
	return affected, mapSQLiteError(err)
}

func (r *SettingsRepository) List(ctx context.Context) ([]*domain.Setting, error) {
	rows, err := queries(ctx, r.db).ListSettings(ctx)
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	out := make([]*domain.Setting, 0, len(rows))
	for _, row := range rows {
		updatedAt, err := parseSQLiteTime(row.UpdatedAt)
		if err != nil {
			return nil, err
		}
		out = append(out, &domain.Setting{
			Key: row.Key, Value: row.Value, UpdatedBy: row.UpdatedBy, UpdatedAt: updatedAt,
		})
	}
	return out, nil
}

func (r *SettingsRepository) Upsert(ctx context.Context, key, value string, updatedBy *int64, now time.Time) error {
	return mapSQLiteError(queries(ctx, r.db).UpsertSetting(ctx, sqlitedb.UpsertSettingParams{
		Key: key, Value: value, UpdatedBy: updatedBy, UpdatedAt: sqliteTime(now),
	}))
}

func (r *AuditRepository) Create(ctx context.Context, in domain.CreateAuditLogInput) error {
	var ip *string
	// NormalizeIP drops malformed addresses so SQLite and PostgreSQL store the
	// same thing (INET would reject them outright).
	if value := domain.NormalizeIP(in.IP); value != "" {
		ip = &value
	}
	return mapSQLiteError(queries(ctx, r.db).CreateAuditLog(ctx, sqlitedb.CreateAuditLogParams{
		ActorID: in.ActorID, Action: in.Action, TargetType: in.TargetType, TargetID: in.TargetID,
		Detail: in.Detail, Ip: ip, CreatedAt: sqliteTime(in.Now),
	}))
}

func (r *AuditRepository) List(ctx context.Context, page domain.Page) ([]*domain.AuditLog, error) {
	rows, err := queries(ctx, r.db).ListAuditLogs(ctx, sqlitedb.ListAuditLogsParams{
		RowOffset: int64(page.Offset), PageSize: int64(page.Limit),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	out := make([]*domain.AuditLog, 0, len(rows))
	for _, row := range rows {
		createdAt, err := parseSQLiteTime(row.CreatedAt)
		if err != nil {
			return nil, err
		}
		entry := &domain.AuditLog{
			ID: row.ID, ActorID: row.ActorID, Action: row.Action,
			TargetType: row.TargetType, TargetID: row.TargetID, Detail: row.Detail,
			CreatedAt: createdAt,
		}
		if row.Ip != nil {
			entry.IP = *row.Ip
		}
		out = append(out, entry)
	}
	return out, nil
}

func (r *AuditRepository) Count(ctx context.Context) (int64, error) {
	v, err := queries(ctx, r.db).CountAuditLogs(ctx)
	return v, mapSQLiteError(err)
}

var _ domain.RefreshTokenRepo = (*RefreshTokenRepository)(nil)
var _ domain.SettingsRepo = (*SettingsRepository)(nil)
var _ domain.AuditRepo = (*AuditRepository)(nil)
