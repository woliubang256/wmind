package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

// ShareRepository implements domain.ShareRepo for PostgreSQL.
type ShareRepository struct {
	pool *pgxpool.Pool
}

// NewShareRepository 构造分享链接仓储。
func NewShareRepository(pool *pgxpool.Pool) *ShareRepository {
	return &ShareRepository{pool: pool}
}

func (r *ShareRepository) queries(ctx context.Context) *pgdb.Queries {
	return queries(ctx, r.pool)
}

// newPGShare 收敛三处 JOIN 查询共用的十五个字段（与 SQLite 侧同构）。
//
// 时间参数用 *time.Time 而不是 pgtype.Timestamptz：转换（fromPGTime）放在
// 调用点，这个函数就与驱动类型无关，和 SQLite 版本的签名一一对应。
func newPGShare(
	id int64, uid, token string, mapID, ownerID int64, passwordHash, passwordCiphertext string,
	allowDownload, showNotes bool, expiresAt *time.Time, viewCount int64,
	lastViewedAt, revokedAt *time.Time, createdAt time.Time, mapUID, mapTitle string,
) *domain.ShareLink {
	return &domain.ShareLink{
		ID: id, UID: uid, Token: token, MapID: mapID, OwnerID: ownerID,
		PasswordHash:       passwordHash,
		PasswordCiphertext: passwordCiphertext,
		AllowDownload:      allowDownload, ShowNotes: showNotes,
		ExpiresAt: expiresAt, ViewCount: int(viewCount),
		LastViewedAt: lastViewedAt, RevokedAt: revokedAt,
		CreatedAt: createdAt, MapUID: mapUID, MapTitle: mapTitle,
	}
}

// mapPGShareRow 处理 CreateShare / UpdateShare 的 RETURNING * 结果。
// 这两条语句没有 JOIN，MapUID / MapTitle 为空（原因见 SQLite 侧同名函数）。
func mapPGShareRow(v pgdb.ShareLink) *domain.ShareLink {
	return newPGShare(
		v.ID, v.Uid, v.Token, v.MapID, v.OwnerID, v.PasswordHash, v.PasswordCiphertext,
		v.AllowDownload, v.ShowNotes, fromPGTime(v.ExpiresAt), v.ViewCount,
		fromPGTime(v.LastViewedAt), fromPGTime(v.RevokedAt), v.CreatedAt.Time.UTC(),
		"", "",
	)
}

func (r *ShareRepository) Create(ctx context.Context, in domain.CreateShareInput) (*domain.ShareLink, error) {
	v, err := r.queries(ctx).CreateShare(ctx, pgdb.CreateShareParams{
		Uid: in.UID, Token: in.Token, MapID: in.MapID, OwnerID: in.OwnerID,
		PasswordHash:       in.PasswordHash,
		PasswordCiphertext: in.PasswordCiphertext,
		AllowDownload:      in.AllowDownload,
		ShowNotes:          in.ShowNotes,
		ExpiresAt:          pgTimePtr(in.ExpiresAt),
		CreatedAt:          pgTime(in.Now),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGShareRow(v), nil
}

func (r *ShareRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.ShareLink, error) {
	row, err := r.queries(ctx).GetShareByUID(ctx, pgdb.GetShareByUIDParams{Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapPGError(err)
	}
	return newPGShare(
		row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, row.PasswordCiphertext,
		row.AllowDownload, row.ShowNotes, fromPGTime(row.ExpiresAt), row.ViewCount,
		fromPGTime(row.LastViewedAt), fromPGTime(row.RevokedAt), row.CreatedAt.Time.UTC(),
		row.MapUid, row.MapTitle,
	), nil
}

func (r *ShareRepository) GetByToken(ctx context.Context, token string) (*domain.ShareDocument, error) {
	row, err := r.queries(ctx).GetShareByToken(ctx, token)
	if err != nil {
		return nil, mapPGError(err)
	}
	share := newPGShare(
		row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, "",
		row.AllowDownload, row.ShowNotes, fromPGTime(row.ExpiresAt), row.ViewCount,
		fromPGTime(row.LastViewedAt), fromPGTime(row.RevokedAt), row.CreatedAt.Time.UTC(),
		row.MapUid, row.MapTitle,
	)
	return &domain.ShareDocument{
		Share: share,
		// 复制一份：pgx 的 []byte 可能指向驱动内部的缓冲，直接持有会在连接
		// 归还后被改写（与 mapPGMap 的处理一致）。
		Document:      append([]byte(nil), row.MapDocument...),
		MapDeleted:    row.MapDeletedAt.Valid,
		OwnerNickname: row.OwnerNickname,
	}, nil
}

func (r *ShareRepository) ListByMap(ctx context.Context, mapID int64, ownerID int64) ([]*domain.ShareLink, error) {
	rows, err := r.queries(ctx).ListSharesByMap(ctx, pgdb.ListSharesByMapParams{
		MapID: mapID, OwnerID: ownerID,
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	out := make([]*domain.ShareLink, 0, len(rows))
	for _, row := range rows {
		out = append(out, newPGShare(
			row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, row.PasswordCiphertext,
			row.AllowDownload, row.ShowNotes, fromPGTime(row.ExpiresAt), row.ViewCount,
			fromPGTime(row.LastViewedAt), fromPGTime(row.RevokedAt), row.CreatedAt.Time.UTC(),
			row.MapUid, row.MapTitle,
		))
	}
	return out, nil
}

func (r *ShareRepository) ListByOwner(ctx context.Context, ownerID int64, mapUID string, page domain.Page) ([]*domain.ShareLink, error) {
	rows, err := r.queries(ctx).ListSharesByOwner(ctx, pgdb.ListSharesByOwnerParams{
		OwnerID: ownerID, MapUid: optionalText(mapUID),
		RowOffset: int32(page.Offset), PageSize: int32(page.Limit),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	out := make([]*domain.ShareLink, 0, len(rows))
	for _, row := range rows {
		out = append(out, newPGShare(
			row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, row.PasswordCiphertext,
			row.AllowDownload, row.ShowNotes, fromPGTime(row.ExpiresAt), row.ViewCount,
			fromPGTime(row.LastViewedAt), fromPGTime(row.RevokedAt), row.CreatedAt.Time.UTC(),
			row.MapUid, row.MapTitle,
		))
	}
	return out, nil
}

func (r *ShareRepository) CountByOwner(ctx context.Context, ownerID int64, mapUID string) (int64, error) {
	v, err := r.queries(ctx).CountSharesByOwner(ctx, pgdb.CountSharesByOwnerParams{
		OwnerID: ownerID, MapUid: optionalText(mapUID),
	})
	return v, mapPGError(err)
}

func (r *ShareRepository) CountActiveByMap(ctx context.Context, mapID int64) (int64, error) {
	v, err := r.queries(ctx).CountActiveSharesByMap(ctx, mapID)
	return v, mapPGError(err)
}

func (r *ShareRepository) Update(ctx context.Context, in domain.UpdateShareInput) (*domain.ShareLink, error) {
	v, err := r.queries(ctx).UpdateShare(ctx, pgdb.UpdateShareParams{
		PasswordHash:       in.PasswordHash,
		PasswordCiphertext: in.PasswordCiphertext,
		AllowDownload:      in.AllowDownload,
		ShowNotes:          in.ShowNotes,
		ExpiresAt:          pgTimePtr(in.ExpiresAt),
		Uid:                in.UID,
		OwnerID:            in.OwnerID,
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGShareRow(v), nil
}

func (r *ShareRepository) Revoke(ctx context.Context, uid string, ownerID int64, now time.Time) error {
	affected, err := r.queries(ctx).RevokeShare(ctx, pgdb.RevokeShareParams{
		RevokedAt: pgTime(now), Uid: uid, OwnerID: ownerID,
	})
	return mapPGRowsAffected(affected, err)
}

func (r *ShareRepository) RecordView(ctx context.Context, id int64, at time.Time) error {
	return mapPGError(r.queries(ctx).RecordShareView(ctx, pgdb.RecordShareViewParams{
		ViewedAt: pgTime(at), ID: id,
	}))
}

// optionalText 把空串转成 NULL（语义见 SQLite 侧的 optionalString：
// 查询里是 COALESCE(narg, col)，传空串会变成 `m.uid = ”`，一条都不匹配）。
func optionalText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var _ domain.ShareRepo = (*ShareRepository)(nil)
