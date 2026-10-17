package postgres

import (
	"context"
	"fmt"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

// RefreshTokenRepository implements domain.RefreshTokenRepo for PostgreSQL.
type RefreshTokenRepository struct{ pool *pgxpool.Pool }

// SettingsRepository implements domain.SettingsRepo for PostgreSQL.
type SettingsRepository struct{ pool *pgxpool.Pool }

// AuditRepository implements domain.AuditRepo for PostgreSQL.
type AuditRepository struct{ pool *pgxpool.Pool }

func NewRefreshTokenRepository(pool *pgxpool.Pool) *RefreshTokenRepository {
	return &RefreshTokenRepository{pool: pool}
}

func NewSettingsRepository(pool *pgxpool.Pool) *SettingsRepository {
	return &SettingsRepository{pool: pool}
}

func NewAuditRepository(pool *pgxpool.Pool) *AuditRepository {
	return &AuditRepository{pool: pool}
}

func mapPGRefreshToken(v pgdb.RefreshToken) *domain.RefreshToken {
	return &domain.RefreshToken{
		ID: v.ID, UserID: v.UserID, TokenHash: v.TokenHash, Platform: v.Platform,
		Device: v.Device, ExpiresAt: v.ExpiresAt.Time.UTC(),
		RevokedAt: fromPGTime(v.RevokedAt), CreatedAt: v.CreatedAt.Time.UTC(),
	}
}

func (r *RefreshTokenRepository) Create(ctx context.Context, in domain.CreateRefreshTokenInput) (*domain.RefreshToken, error) {
	v, err := queries(ctx, r.pool).CreateRefreshToken(ctx, pgdb.CreateRefreshTokenParams{
		UserID: in.UserID, TokenHash: in.TokenHash, Platform: in.Platform,
		Device: in.Device, ExpiresAt: pgTime(in.ExpiresAt), CreatedAt: pgTime(in.Now),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGRefreshToken(v), nil
}

func (r *RefreshTokenRepository) GetByHash(ctx context.Context, tokenHash string) (*domain.RefreshToken, error) {
	v, err := queries(ctx, r.pool).GetRefreshTokenByHash(ctx, tokenHash)
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGRefreshToken(v), nil
}

func (r *RefreshTokenRepository) Revoke(ctx context.Context, tokenHash string, at time.Time) (bool, error) {
	affected, err := queries(ctx, r.pool).RevokeRefreshToken(ctx, pgdb.RevokeRefreshTokenParams{
		RevokedAt: pgTime(at), TokenHash: tokenHash,
	})
	if err != nil {
		return false, mapPGError(err)
	}
	return affected > 0, nil
}

func (r *RefreshTokenRepository) RevokeAllForUser(ctx context.Context, userID int64, at time.Time) (int64, error) {
	affected, err := queries(ctx, r.pool).RevokeUserRefreshTokens(ctx, pgdb.RevokeUserRefreshTokensParams{
		RevokedAt: pgTime(at), UserID: userID,
	})
	return affected, mapPGError(err)
}

func (r *RefreshTokenRepository) RevokeAllExcept(ctx context.Context, userID int64, keepTokenHash string, at time.Time) (int64, error) {
	affected, err := queries(ctx, r.pool).RevokeUserRefreshTokensExcept(ctx, pgdb.RevokeUserRefreshTokensExceptParams{
		RevokedAt: pgTime(at), UserID: userID, KeepTokenHash: keepTokenHash,
	})
	return affected, mapPGError(err)
}

func (r *RefreshTokenRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	affected, err := queries(ctx, r.pool).DeleteExpiredRefreshTokens(ctx, pgTime(before))
	return affected, mapPGError(err)
}

func (r *SettingsRepository) List(ctx context.Context) ([]*domain.Setting, error) {
	rows, err := queries(ctx, r.pool).ListSettings(ctx)
	if err != nil {
		return nil, mapPGError(err)
	}
	out := make([]*domain.Setting, 0, len(rows))
	for _, row := range rows {
		out = append(out, &domain.Setting{
			Key: row.Key, Value: string(row.Value), UpdatedBy: row.UpdatedBy,
			UpdatedAt: row.UpdatedAt.Time.UTC(),
		})
	}
	return out, nil
}

func (r *SettingsRepository) Upsert(ctx context.Context, key, value string, updatedBy *int64, now time.Time) error {
	return mapPGError(queries(ctx, r.pool).UpsertSetting(ctx, pgdb.UpsertSettingParams{
		Key: key, Value: []byte(value), UpdatedBy: updatedBy, UpdatedAt: pgTime(now),
	}))
}

func (r *AuditRepository) Create(ctx context.Context, in domain.CreateAuditLogInput) error {
	// The column is INET, so the boundary has to hand pgx a real address.
	// NormalizeIP keeps this path identical to SQLite's, where the column would
	// happily accept a malformed string.
	var ip *netip.Addr
	if normalized := domain.NormalizeIP(in.IP); normalized != "" {
		addr, err := netip.ParseAddr(normalized)
		if err != nil {
			return fmt.Errorf("parse normalized audit IP %q: %w", normalized, err)
		}
		ip = &addr
	}
	return mapPGError(queries(ctx, r.pool).CreateAuditLog(ctx, pgdb.CreateAuditLogParams{
		ActorID: in.ActorID, Action: in.Action, TargetType: in.TargetType, TargetID: in.TargetID,
		Detail: []byte(in.Detail), Ip: ip, CreatedAt: pgTime(in.Now),
	}))
}

func (r *AuditRepository) List(ctx context.Context, filter domain.AuditFilter, page domain.Page) ([]*domain.AuditLog, error) {
	params := pgdb.ListAuditLogsParams{
		RowOffset: int32(page.Offset), PageSize: int32(page.Limit),
	}
	if filter.Action != "" {
		action := filter.Action
		params.Action = &action
	}
	params.ActorID = filter.ActorID
	params.FromTime = pgTimePtr(filter.From)
	params.ToTime = pgTimePtr(filter.To)

	rows, err := queries(ctx, r.pool).ListAuditLogs(ctx, params)
	if err != nil {
		return nil, mapPGError(err)
	}
	out := make([]*domain.AuditLog, 0, len(rows))
	for _, row := range rows {
		entry := &domain.AuditLog{
			ID: row.ID, ActorID: row.ActorID, Action: row.Action,
			TargetType: row.TargetType, TargetID: row.TargetID,
			Detail: string(row.Detail), CreatedAt: row.CreatedAt.Time.UTC(),
		}
		if row.Ip != nil {
			entry.IP = row.Ip.String()
		}
		out = append(out, entry)
	}
	return out, nil
}

func (r *AuditRepository) Count(ctx context.Context, filter domain.AuditFilter) (int64, error) {
	params := pgdb.CountAuditLogsParams{ActorID: filter.ActorID}
	if filter.Action != "" {
		action := filter.Action
		params.Action = &action
	}
	params.FromTime = pgTimePtr(filter.From)
	params.ToTime = pgTimePtr(filter.To)
	v, err := queries(ctx, r.pool).CountAuditLogs(ctx, params)
	return v, mapPGError(err)
}

var _ domain.RefreshTokenRepo = (*RefreshTokenRepository)(nil)
var _ domain.SettingsRepo = (*SettingsRepository)(nil)
var _ domain.AuditRepo = (*AuditRepository)(nil)
