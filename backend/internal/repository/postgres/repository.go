package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

// UserRepository implements domain.UserRepo for PostgreSQL.
type UserRepository struct {
	pool *pgxpool.Pool
}

// MapRepository implements domain.MapRepo for PostgreSQL.
type MapRepository struct {
	pool *pgxpool.Pool
}

// TransactionManager implements domain.TxManager for PostgreSQL.
type TransactionManager struct {
	pool *pgxpool.Pool
}

func NewUserRepository(pool *pgxpool.Pool) *UserRepository { return &UserRepository{pool: pool} }
func NewMapRepository(pool *pgxpool.Pool) *MapRepository   { return &MapRepository{pool: pool} }
func NewTxManager(pool *pgxpool.Pool) *TransactionManager  { return &TransactionManager{pool: pool} }

func (r *UserRepository) queries(ctx context.Context) *pgdb.Queries {
	return queries(ctx, r.pool)
}

func (r *MapRepository) queries(ctx context.Context) *pgdb.Queries {
	return queries(ctx, r.pool)
}

func queries(ctx context.Context, pool *pgxpool.Pool) *pgdb.Queries {
	if handle, ok := domain.TxHandle(ctx); ok {
		tx, ok := handle.(pgx.Tx)
		if !ok {
			panic(fmt.Sprintf("unexpected PostgreSQL transaction handle %T", handle))
		}
		return pgdb.New(tx)
	}
	return pgdb.New(pool)
}

func (r *TransactionManager) WithTx(ctx context.Context, fn func(context.Context) error) error {
	if _, ok := domain.TxHandle(ctx); ok {
		// Nested service scopes reuse the existing transaction. Savepoints are
		// deliberately not implicit: a nested failure is still an outer failure.
		return fn(ctx)
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin PostgreSQL transaction: %w", err)
	}
	txCtx := domain.WithTxHandle(ctx, tx)
	if err := fn(txCtx); err != nil {
		if rollbackErr := tx.Rollback(context.Background()); rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			return fmt.Errorf("transaction callback failed: %w (rollback failed: %v)", err, rollbackErr)
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit PostgreSQL transaction: %w", err)
	}
	return nil
}

func pgTime(t time.Time) pgtype.Timestamptz {
	// SQLite stores fixed-width millisecond timestamps. Truncate on PostgreSQL
	// too so contract tests and cross-dialect exports observe identical values.
	return pgtype.Timestamptz{Time: t.UTC().Truncate(time.Millisecond), Valid: true}
}

func pgTimePtr(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return pgTime(*t)
}

func fromPGTime(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time.UTC()
	return &v
}

func mapPGUser(v pgdb.User) *domain.User {
	return &domain.User{
		ID: v.ID, UID: v.Uid, Username: v.Username, Email: v.Email,
		PasswordHash: v.PasswordHash, Nickname: v.Nickname, AvatarURL: v.AvatarUrl,
		Role: domain.Role(v.Role), Status: domain.UserStatus(v.Status), MapCount: int(v.MapCount),
		LastLoginAt: fromPGTime(v.LastLoginAt), CreatedAt: v.CreatedAt.Time.UTC(),
		UpdatedAt: v.UpdatedAt.Time.UTC(), DeletedAt: fromPGTime(v.DeletedAt),
	}
}

func mapPGMap(v pgdb.Map) *domain.Map {
	return &domain.Map{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Title: v.Title,
		Document: append([]byte(nil), v.Document...), Version: int(v.Version),
		ThumbnailURL: v.ThumbnailUrl, NodeCount: int(v.NodeCount), SizeBytes: int64(v.SizeBytes),
		DeletedAt: fromPGTime(v.DeletedAt), CreatedAt: v.CreatedAt.Time.UTC(), UpdatedAt: v.UpdatedAt.Time.UTC(),
	}
}

func keywordPattern(keyword string) string {
	if keyword == "" {
		return ""
	}
	return "%" + keyword + "%"
}

func mapPGRowsAffected(affected int64, err error) error {
	if err != nil {
		return mapPGError(err)
	}
	if affected == 0 {
		return domain.ErrNotFound
	}
	return nil
}

func mapPGError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return fmt.Errorf("%w: %s", domain.ErrDuplicate, pgErr.ConstraintName)
	}
	return err
}

func (r *UserRepository) user(ctx context.Context, call func(*pgdb.Queries) (pgdb.User, error)) (*domain.User, error) {
	v, err := call(r.queries(ctx))
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGUser(v), nil
}

func (r *UserRepository) Create(ctx context.Context, in domain.CreateUserInput) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) {
		return q.CreateUser(ctx, pgdb.CreateUserParams{
			Uid: in.UID, Username: in.Username, Email: in.Email, PasswordHash: in.PasswordHash,
			Nickname: in.Nickname, AvatarUrl: in.AvatarURL, Role: string(in.Role), Status: string(in.Status),
			CreatedAt: pgTime(in.Now), UpdatedAt: pgTime(in.Now),
		})
	})
}

func (r *UserRepository) GetByID(ctx context.Context, id int64) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) { return q.GetUserByID(ctx, id) })
}

func (r *UserRepository) GetByUID(ctx context.Context, uid string) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) { return q.GetUserByUID(ctx, uid) })
}

func (r *UserRepository) GetByEmail(ctx context.Context, email string) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) { return q.GetUserByEmail(ctx, email) })
}

func (r *UserRepository) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) { return q.GetUserByUsername(ctx, username) })
}

func (r *UserRepository) Count(ctx context.Context) (int64, error) {
	v, err := r.queries(ctx).CountUsers(ctx)
	return v, mapPGError(err)
}

func (r *UserRepository) CountActiveAdmins(ctx context.Context) (int64, error) {
	v, err := r.queries(ctx).CountActiveAdmins(ctx)
	return v, mapPGError(err)
}

func (r *UserRepository) List(ctx context.Context, in domain.ListUsersInput) ([]*domain.User, error) {
	rows, err := r.queries(ctx).ListUsers(ctx, pgdb.ListUsersParams{
		Keyword: keywordPattern(in.Keyword), Role: string(in.Role), Status: string(in.Status),
		RowOffset: int32(in.Page.Offset), PageSize: int32(in.Page.Limit),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	out := make([]*domain.User, 0, len(rows))
	for _, row := range rows {
		out = append(out, mapPGUser(row))
	}
	return out, nil
}

func (r *UserRepository) CountFiltered(ctx context.Context, in domain.ListUsersInput) (int64, error) {
	v, err := r.queries(ctx).CountUsersFiltered(ctx, pgdb.CountUsersFilteredParams{
		Keyword: keywordPattern(in.Keyword), Role: string(in.Role), Status: string(in.Status),
	})
	return v, mapPGError(err)
}

func (r *UserRepository) UpdateProfile(ctx context.Context, in domain.UpdateProfileInput) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) {
		return q.UpdateUserProfile(ctx, pgdb.UpdateUserProfileParams{
			Nickname: in.Nickname, AvatarUrl: in.AvatarURL, UpdatedAt: pgTime(in.Now), Uid: in.UID,
		})
	})
}

func (r *UserRepository) UpdatePassword(ctx context.Context, id int64, passwordHash string, now time.Time) error {
	affected, err := r.queries(ctx).UpdateUserPassword(ctx, pgdb.UpdateUserPasswordParams{
		PasswordHash: passwordHash, UpdatedAt: pgTime(now), ID: id,
	})
	return mapPGRowsAffected(affected, err)
}

func (r *UserRepository) UpdateStatus(ctx context.Context, uid string, status domain.UserStatus, now time.Time) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) {
		return q.UpdateUserStatus(ctx, pgdb.UpdateUserStatusParams{Status: string(status), UpdatedAt: pgTime(now), Uid: uid})
	})
}

func (r *UserRepository) UpdateRole(ctx context.Context, uid string, role domain.Role, now time.Time) (*domain.User, error) {
	return r.user(ctx, func(q *pgdb.Queries) (pgdb.User, error) {
		return q.UpdateUserRole(ctx, pgdb.UpdateUserRoleParams{Role: string(role), UpdatedAt: pgTime(now), Uid: uid})
	})
}

func (r *UserRepository) TouchLastLogin(ctx context.Context, id int64, at time.Time) error {
	affected, err := r.queries(ctx).TouchUserLastLogin(ctx, pgdb.TouchUserLastLoginParams{
		LastLoginAt: pgTime(at), UpdatedAt: pgTime(at), ID: id,
	})
	return mapPGRowsAffected(affected, err)
}

func (r *UserRepository) SoftDelete(ctx context.Context, uid string, now time.Time) error {
	affected, err := r.queries(ctx).SoftDeleteUser(ctx, pgdb.SoftDeleteUserParams{
		DeletedAt: pgTime(now), UpdatedAt: pgTime(now), Uid: uid,
	})
	return mapPGRowsAffected(affected, err)
}

func (r *UserRepository) IncrementMapCount(ctx context.Context, id int64, delta int, now time.Time) error {
	affected, err := r.queries(ctx).IncrementUserMapCount(ctx, pgdb.IncrementUserMapCountParams{
		Delta: int32(delta), UpdatedAt: pgTime(now), ID: id,
	})
	return mapPGRowsAffected(affected, err)
}

func (r *MapRepository) Create(ctx context.Context, in domain.CreateMapInput) (*domain.Map, error) {
	v, err := r.queries(ctx).CreateMap(ctx, pgdb.CreateMapParams{
		Uid: in.UID, OwnerID: in.OwnerID, Title: in.Title, Document: in.Document,
		NodeCount: int32(in.NodeCount), SizeBytes: in.SizeBytes,
		CreatedAt: pgTime(in.Now), UpdatedAt: pgTime(in.Now),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMap(v), nil
}

func (r *MapRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.Map, error) {
	v, err := r.queries(ctx).GetMapByUID(ctx, pgdb.GetMapByUIDParams{Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMap(v), nil
}

func (r *MapRepository) GetForUpdate(ctx context.Context, uid string, ownerID int64) (*domain.Map, error) {
	if _, ok := domain.TxHandle(ctx); !ok {
		return nil, errors.New("GetForUpdate requires an active transaction")
	}
	v, err := r.queries(ctx).GetMapForUpdate(ctx, pgdb.GetMapForUpdateParams{Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMap(v), nil
}

func (r *MapRepository) ListByOwner(ctx context.Context, ownerID int64, page domain.Page) ([]*domain.Map, error) {
	rows, err := r.queries(ctx).ListMapsByOwner(ctx, pgdb.ListMapsByOwnerParams{
		OwnerID: ownerID, RowOffset: int32(page.Offset), PageSize: int32(page.Limit),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMaps(rows), nil
}

func (r *MapRepository) CountByOwner(ctx context.Context, ownerID int64) (int64, error) {
	v, err := r.queries(ctx).CountMapsByOwner(ctx, ownerID)
	return v, mapPGError(err)
}

func (r *MapRepository) SearchByTitle(ctx context.Context, ownerID int64, pattern string, page domain.Page) ([]*domain.Map, error) {
	rows, err := r.queries(ctx).SearchMapsByTitle(ctx, pgdb.SearchMapsByTitleParams{
		OwnerID: ownerID, Pattern: pattern, RowOffset: int32(page.Offset), PageSize: int32(page.Limit),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMaps(rows), nil
}

func (r *MapRepository) CountByTitle(ctx context.Context, ownerID int64, pattern string) (int64, error) {
	v, err := r.queries(ctx).CountMapsByTitle(ctx, pgdb.CountMapsByTitleParams{OwnerID: ownerID, Pattern: pattern})
	return v, mapPGError(err)
}

func (r *MapRepository) UpdateWithVersion(ctx context.Context, in domain.UpdateMapInput) (*domain.Map, error) {
	v, err := r.queries(ctx).UpdateMapWithVersion(ctx, pgdb.UpdateMapWithVersionParams{
		Title: in.Title, Document: in.Document, ThumbnailUrl: in.ThumbnailURL,
		NodeCount: int32(in.NodeCount), SizeBytes: in.SizeBytes, UpdatedAt: pgTime(in.Now),
		Uid: in.UID, OwnerID: in.OwnerID, ExpectedVersion: int32(in.ExpectedVersion),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if _, getErr := r.GetByUID(ctx, in.UID, in.OwnerID); getErr == nil {
				return nil, domain.ErrVersionConflict
			} else if errors.Is(getErr, domain.ErrNotFound) {
				return nil, domain.ErrNotFound
			} else {
				return nil, getErr
			}
		}
		return nil, mapPGError(err)
	}
	return mapPGMap(v), nil
}

func (r *MapRepository) UpdateMeta(ctx context.Context, uid string, ownerID int64, title string, now time.Time) (*domain.Map, error) {
	v, err := r.queries(ctx).UpdateMapMeta(ctx, pgdb.UpdateMapMetaParams{
		Title: title, UpdatedAt: pgTime(now), Uid: uid, OwnerID: ownerID,
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMap(v), nil
}

func (r *MapRepository) UpdateThumbnail(ctx context.Context, uid string, ownerID int64, thumbnailURL string, now time.Time) error {
	affected, err := r.queries(ctx).UpdateMapThumbnail(ctx, pgdb.UpdateMapThumbnailParams{
		ThumbnailUrl: thumbnailURL, UpdatedAt: pgTime(now), Uid: uid, OwnerID: ownerID,
	})
	return mapPGRowsAffected(affected, err)
}

func (r *MapRepository) SoftDelete(ctx context.Context, uid string, ownerID int64, now time.Time) error {
	affected, err := r.queries(ctx).SoftDeleteMap(ctx, pgdb.SoftDeleteMapParams{
		DeletedAt: pgTime(now), UpdatedAt: pgTime(now), Uid: uid, OwnerID: ownerID,
	})
	return mapPGRowsAffected(affected, err)
}

func (r *MapRepository) Restore(ctx context.Context, uid string, ownerID int64, now time.Time) (*domain.Map, error) {
	v, err := r.queries(ctx).RestoreMap(ctx, pgdb.RestoreMapParams{UpdatedAt: pgTime(now), Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMap(v), nil
}

func (r *MapRepository) ListTrashed(ctx context.Context, ownerID int64, page domain.Page) ([]*domain.Map, error) {
	rows, err := r.queries(ctx).ListTrashedMaps(ctx, pgdb.ListTrashedMapsParams{
		OwnerID: ownerID, RowOffset: int32(page.Offset), PageSize: int32(page.Limit),
	})
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMaps(rows), nil
}

func (r *MapRepository) CountTrashed(ctx context.Context, ownerID int64) (int64, error) {
	v, err := r.queries(ctx).CountTrashedMaps(ctx, ownerID)
	return v, mapPGError(err)
}

func (r *MapRepository) HardDelete(ctx context.Context, uid string, ownerID int64) error {
	affected, err := r.queries(ctx).HardDeleteMap(ctx, pgdb.HardDeleteMapParams{Uid: uid, OwnerID: ownerID})
	return mapPGRowsAffected(affected, err)
}

func (r *MapRepository) HardDeleteTrashed(ctx context.Context, ownerID int64) error {
	return mapPGError(r.queries(ctx).HardDeleteTrashedMaps(ctx, ownerID))
}

func (r *MapRepository) ListAllIncludingDeleted(ctx context.Context, ownerID int64) ([]*domain.Map, error) {
	rows, err := r.queries(ctx).ListAllMapsByOwnerIncludingDeleted(ctx, ownerID)
	if err != nil {
		return nil, mapPGError(err)
	}
	return mapPGMaps(rows), nil
}

func mapPGMaps(rows []pgdb.Map) []*domain.Map {
	out := make([]*domain.Map, 0, len(rows))
	for _, row := range rows {
		out = append(out, mapPGMap(row))
	}
	return out
}

var _ domain.UserRepo = (*UserRepository)(nil)
var _ domain.MapRepo = (*MapRepository)(nil)
var _ domain.TxManager = (*TransactionManager)(nil)
