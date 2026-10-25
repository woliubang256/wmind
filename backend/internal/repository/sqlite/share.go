package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

// ShareRepository implements domain.ShareRepo for SQLite.
type ShareRepository struct{ db *sql.DB }

// NewShareRepository 构造分享链接仓储。
func NewShareRepository(db *sql.DB) *ShareRepository { return &ShareRepository{db: db} }

// newSQLiteShare 把三处 JOIN 查询共用的十五个字段收敛成一个领域对象。
//
// 三种查询（按 uid / 按 map / 按属主）生成的 Go 结构体互不相同但字段完全
// 一致，让它们各自写一遍映射只会得到三份会各自漂移的代码。
func newSQLiteShare(
	id int64, uid, token string, mapID, ownerID int64, passwordHash, passwordCiphertext string,
	allowDownload, showNotes int64, expiresAt *string, viewCount int64,
	lastViewedAt, revokedAt *string, createdAt, mapUID, mapTitle string,
) (*domain.ShareLink, error) {
	created, err := parseSQLiteTime(createdAt)
	if err != nil {
		return nil, err
	}
	expires, err := parseSQLiteTimePtr(expiresAt)
	if err != nil {
		return nil, err
	}
	lastViewed, err := parseSQLiteTimePtr(lastViewedAt)
	if err != nil {
		return nil, err
	}
	revoked, err := parseSQLiteTimePtr(revokedAt)
	if err != nil {
		return nil, err
	}
	return &domain.ShareLink{
		ID: id, UID: uid, Token: token, MapID: mapID, OwnerID: ownerID,
		PasswordHash: passwordHash, PasswordCiphertext: passwordCiphertext,
		// SQLite 没有布尔类型，这两列是 INTEGER + CHECK (col IN (0,1))。
		AllowDownload: allowDownload != 0,
		ShowNotes:     showNotes != 0,
		ExpiresAt:     expires, ViewCount: int(viewCount), LastViewedAt: lastViewed,
		RevokedAt: revoked, CreatedAt: created,
		MapUID: mapUID, MapTitle: mapTitle,
	}, nil
}

// mapSQLiteShareRow 处理 CreateShare / UpdateShare 的 RETURNING * 结果。
//
// 这两条语句没有 JOIN，所以 MapUID / MapTitle 为空——调用方要么已经知道
// 是哪张导图（创建），要么从读出来的那一行复制（改写）。
func mapSQLiteShareRow(v sqlitedb.ShareLink) (*domain.ShareLink, error) {
	return newSQLiteShare(
		v.ID, v.Uid, v.Token, v.MapID, v.OwnerID, v.PasswordHash, v.PasswordCiphertext,
		v.AllowDownload, v.ShowNotes, v.ExpiresAt, v.ViewCount,
		v.LastViewedAt, v.RevokedAt, v.CreatedAt, "", "",
	)
}

func mapSQLiteShares(rows []sqlitedb.ListSharesByOwnerRow) ([]*domain.ShareLink, error) {
	out := make([]*domain.ShareLink, 0, len(rows))
	for _, row := range rows {
		v, err := newSQLiteShare(
			row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, row.PasswordCiphertext,
			row.AllowDownload, row.ShowNotes, row.ExpiresAt, row.ViewCount,
			row.LastViewedAt, row.RevokedAt, row.CreatedAt, row.MapUid, row.MapTitle,
		)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (r *ShareRepository) Create(ctx context.Context, in domain.CreateShareInput) (*domain.ShareLink, error) {
	v, err := queries(ctx, r.db).CreateShare(ctx, sqlitedb.CreateShareParams{
		Uid: in.UID, Token: in.Token, MapID: in.MapID, OwnerID: in.OwnerID,
		PasswordHash:       in.PasswordHash,
		PasswordCiphertext: in.PasswordCiphertext,
		AllowDownload:      boolToSQLite(in.AllowDownload),
		ShowNotes:          boolToSQLite(in.ShowNotes),
		ExpiresAt:          sqliteOptionalTime(in.ExpiresAt),
		CreatedAt:          sqliteTime(in.Now),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteShareRow(v)
}

func (r *ShareRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.ShareLink, error) {
	row, err := queries(ctx, r.db).GetShareByUID(ctx, sqlitedb.GetShareByUIDParams{Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return newSQLiteShare(
		row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, row.PasswordCiphertext,
		row.AllowDownload, row.ShowNotes, row.ExpiresAt, row.ViewCount,
		row.LastViewedAt, row.RevokedAt, row.CreatedAt, row.MapUid, row.MapTitle,
	)
}

func (r *ShareRepository) GetByToken(ctx context.Context, token string) (*domain.ShareDocument, error) {
	row, err := queries(ctx, r.db).GetShareByToken(ctx, token)
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	share, err := newSQLiteShare(
		row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, "",
		row.AllowDownload, row.ShowNotes, row.ExpiresAt, row.ViewCount,
		row.LastViewedAt, row.RevokedAt, row.CreatedAt, row.MapUid, row.MapTitle,
	)
	if err != nil {
		return nil, err
	}
	return &domain.ShareDocument{
		Share:         share,
		Document:      []byte(row.MapDocument),
		MapDeleted:    row.MapDeletedAt != nil,
		OwnerNickname: row.OwnerNickname,
	}, nil
}

func (r *ShareRepository) ListByMap(ctx context.Context, mapID int64, ownerID int64) ([]*domain.ShareLink, error) {
	rows, err := queries(ctx, r.db).ListSharesByMap(ctx, sqlitedb.ListSharesByMapParams{
		MapID: mapID, OwnerID: ownerID,
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	out := make([]*domain.ShareLink, 0, len(rows))
	for _, row := range rows {
		v, err := newSQLiteShare(
			row.ID, row.Uid, row.Token, row.MapID, row.OwnerID, row.PasswordHash, row.PasswordCiphertext,
			row.AllowDownload, row.ShowNotes, row.ExpiresAt, row.ViewCount,
			row.LastViewedAt, row.RevokedAt, row.CreatedAt, row.MapUid, row.MapTitle,
		)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (r *ShareRepository) ListByOwner(ctx context.Context, ownerID int64, mapUID string, page domain.Page) ([]*domain.ShareLink, error) {
	rows, err := queries(ctx, r.db).ListSharesByOwner(ctx, sqlitedb.ListSharesByOwnerParams{
		OwnerID: ownerID, MapUid: optionalString(mapUID),
		RowOffset: int64(page.Offset), PageSize: int64(page.Limit),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteShares(rows)
}

func (r *ShareRepository) CountByOwner(ctx context.Context, ownerID int64, mapUID string) (int64, error) {
	v, err := queries(ctx, r.db).CountSharesByOwner(ctx, sqlitedb.CountSharesByOwnerParams{
		OwnerID: ownerID, MapUid: optionalString(mapUID),
	})
	return v, mapSQLiteError(err)
}

func (r *ShareRepository) CountActiveByMap(ctx context.Context, mapID int64) (int64, error) {
	v, err := queries(ctx, r.db).CountActiveSharesByMap(ctx, mapID)
	return v, mapSQLiteError(err)
}

func (r *ShareRepository) Update(ctx context.Context, in domain.UpdateShareInput) (*domain.ShareLink, error) {
	v, err := queries(ctx, r.db).UpdateShare(ctx, sqlitedb.UpdateShareParams{
		PasswordHash:         in.PasswordHash,
		ExpectedPasswordHash: in.ExpectedPasswordHash,
		PasswordCiphertext:   in.PasswordCiphertext,
		AllowDownload:        boolToSQLite(in.AllowDownload),
		ShowNotes:            boolToSQLite(in.ShowNotes),
		ExpiresAt:            sqliteOptionalTime(in.ExpiresAt),
		Uid:                  in.UID,
		OwnerID:              in.OwnerID,
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteShareRow(v)
}

func (r *ShareRepository) Revoke(ctx context.Context, uid string, ownerID int64, now time.Time) error {
	affected, err := queries(ctx, r.db).RevokeShare(ctx, sqlitedb.RevokeShareParams{
		RevokedAt: sqliteRequiredNullableTime(now), Uid: uid, OwnerID: ownerID,
	})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *ShareRepository) RecordView(ctx context.Context, id int64, at time.Time) error {
	return mapSQLiteError(queries(ctx, r.db).RecordShareView(ctx, sqlitedb.RecordShareViewParams{
		ViewedAt: sqliteRequiredNullableTime(at), ID: id,
	}))
}

// boolToSQLite 把布尔值转成 SQLite 的 0/1。
//
// 不做 `if b { return 1 }` 之外的任何处理：CHECK (col IN (0,1)) 会拒绝别的
// 值，与其在这里静默兜底，不如让约束在写错时报错。
func boolToSQLite(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// sqliteOptionalTime 把可空时间转成可空字符串列。
//
// 不能直接用 sqliteTimePtr：它返回 any（给 sqlc 的 narg 参数用），而这里
// 的 ExpiresAt 是 *string 列。
func sqliteOptionalTime(t *time.Time) *string {
	if t == nil {
		return nil
	}
	v := sqliteTime(*t)
	return &v
}

// optionalString 把空串转成 nil。
//
// 「没筛这个字段」必须用 NULL 表达：查询里是 COALESCE(narg, col)，
// 传空串会变成 `m.uid = ”`，一条都匹配不上。
func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var _ domain.ShareRepo = (*ShareRepository)(nil)
