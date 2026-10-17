package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	sqlitedriver "modernc.org/sqlite"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/timeutil"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite/sqlitedb"
)

// UserRepository implements domain.UserRepo for SQLite.
type UserRepository struct{ db *sql.DB }

// MapRepository implements domain.MapRepo for SQLite.
type MapRepository struct{ db *sql.DB }

// TransactionManager implements domain.TxManager using a pinned connection and
// BEGIN IMMEDIATE. The pinned connection is placed in context so generated
// queries cannot accidentally escape the transaction back to *sql.DB.
type TransactionManager struct{ db *sql.DB }

type immediateTx struct{ *sql.Conn }

func NewUserRepository(db *sql.DB) *UserRepository { return &UserRepository{db: db} }
func NewMapRepository(db *sql.DB) *MapRepository   { return &MapRepository{db: db} }
func NewTxManager(db *sql.DB) *TransactionManager  { return &TransactionManager{db: db} }

func queries(ctx context.Context, db *sql.DB) *sqlitedb.Queries {
	if handle, ok := domain.TxHandle(ctx); ok {
		tx, ok := handle.(*immediateTx)
		if !ok {
			panic(fmt.Sprintf("unexpected SQLite transaction handle %T", handle))
		}
		return sqlitedb.New(tx)
	}
	return sqlitedb.New(db)
}

func (r *TransactionManager) WithTx(ctx context.Context, fn func(context.Context) error) error {
	if _, ok := domain.TxHandle(ctx); ok {
		// Nested service scopes reuse the outer SQLite transaction. They do not
		// create savepoints; a nested error propagates and rolls back the outer TX.
		return fn(ctx)
	}
	conn, err := r.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire SQLite transaction connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("begin SQLite immediate transaction: %w", err)
	}
	if err := fn(domain.WithTxHandle(ctx, &immediateTx{Conn: conn})); err != nil {
		if _, rollbackErr := conn.ExecContext(context.Background(), "ROLLBACK"); rollbackErr != nil {
			return fmt.Errorf("transaction callback failed: %w (rollback failed: %v)", err, rollbackErr)
		}
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		return fmt.Errorf("commit SQLite transaction: %w", err)
	}
	return nil
}

func mapSQLiteError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ErrNotFound
	}
	var sqliteErr *sqlitedriver.Error
	if errors.As(err, &sqliteErr) {
		// SQLITE_CONSTRAINT_PRIMARYKEY and SQLITE_CONSTRAINT_UNIQUE (extended
		// result codes) are the two uniqueness errors surfaced by modernc.
		if sqliteErr.Code() == 1555 || sqliteErr.Code() == 2067 {
			return fmt.Errorf("%w: %v", domain.ErrDuplicate, err)
		}
	}
	return err
}

func sqliteKeywordPattern(keyword string) string {
	if keyword == "" {
		return ""
	}
	return "%" + keyword + "%"
}

func mapSQLiteRowsAffected(affected int64, err error) error {
	if err != nil {
		return mapSQLiteError(err)
	}
	if affected == 0 {
		return domain.ErrNotFound
	}
	return nil
}

func sqliteTime(t time.Time) string { return timeutil.Format(t) }

func sqliteTimePtr(t *time.Time) any { return timeutil.FormatPtr(t) }

func sqliteRequiredNullableTime(t time.Time) *string {
	value := sqliteTime(t)
	return &value
}

func parseSQLiteTime(s string) (time.Time, error) {
	t, err := timeutil.Parse(s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse SQLite UTC timestamp %q: %w", s, err)
	}
	return t, nil
}

func parseSQLiteTimePtr(s *string) (*time.Time, error) {
	if s == nil {
		return nil, nil
	}
	t, err := parseSQLiteTime(*s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func mapSQLiteUser(v sqlitedb.User) (*domain.User, error) {
	createdAt, err := parseSQLiteTime(v.CreatedAt)
	if err != nil {
		return nil, err
	}
	updatedAt, err := parseSQLiteTime(v.UpdatedAt)
	if err != nil {
		return nil, err
	}
	lastLoginAt, err := parseSQLiteTimePtr(v.LastLoginAt)
	if err != nil {
		return nil, err
	}
	deletedAt, err := parseSQLiteTimePtr(v.DeletedAt)
	if err != nil {
		return nil, err
	}
	return &domain.User{
		ID: v.ID, UID: v.Uid, Username: v.Username, Email: v.Email,
		PasswordHash: v.PasswordHash, Nickname: v.Nickname, AvatarURL: v.AvatarUrl,
		Role: domain.Role(v.Role), Status: domain.UserStatus(v.Status), MapCount: int(v.MapCount),
		LastLoginAt: lastLoginAt, CreatedAt: createdAt, UpdatedAt: updatedAt, DeletedAt: deletedAt,
	}, nil
}

func mapSQLiteMap(v sqlitedb.Map) (*domain.Map, error) {
	createdAt, err := parseSQLiteTime(v.CreatedAt)
	if err != nil {
		return nil, err
	}
	updatedAt, err := parseSQLiteTime(v.UpdatedAt)
	if err != nil {
		return nil, err
	}
	deletedAt, err := parseSQLiteTimePtr(v.DeletedAt)
	if err != nil {
		return nil, err
	}
	return &domain.Map{
		ID: v.ID, UID: v.Uid, OwnerID: v.OwnerID, Title: v.Title,
		Document: []byte(v.Document), Version: int(v.Version), ThumbnailURL: v.ThumbnailUrl,
		NodeCount: int(v.NodeCount), SizeBytes: v.SizeBytes, DeletedAt: deletedAt,
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}, nil
}

func (r *UserRepository) user(ctx context.Context, call func(*sqlitedb.Queries) (sqlitedb.User, error)) (*domain.User, error) {
	v, err := call(queries(ctx, r.db))
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteUser(v)
}

func (r *UserRepository) Create(ctx context.Context, in domain.CreateUserInput) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) {
		return q.CreateUser(ctx, sqlitedb.CreateUserParams{
			Uid: in.UID, Username: in.Username, Email: in.Email, PasswordHash: in.PasswordHash,
			Nickname: in.Nickname, AvatarUrl: in.AvatarURL, Role: string(in.Role), Status: string(in.Status),
			CreatedAt: sqliteTime(in.Now), UpdatedAt: sqliteTime(in.Now),
		})
	})
}

func (r *UserRepository) GetByID(ctx context.Context, id int64) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) { return q.GetUserByID(ctx, id) })
}

func (r *UserRepository) GetByUID(ctx context.Context, uid string) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) { return q.GetUserByUID(ctx, uid) })
}

func (r *UserRepository) GetByEmail(ctx context.Context, email string) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) { return q.GetUserByEmail(ctx, email) })
}

func (r *UserRepository) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) { return q.GetUserByUsername(ctx, username) })
}

func (r *UserRepository) Count(ctx context.Context) (int64, error) {
	v, err := queries(ctx, r.db).CountUsers(ctx)
	return v, mapSQLiteError(err)
}

func (r *UserRepository) CountActiveAdmins(ctx context.Context) (int64, error) {
	v, err := queries(ctx, r.db).CountActiveAdmins(ctx)
	return v, mapSQLiteError(err)
}

func (r *UserRepository) List(ctx context.Context, in domain.ListUsersInput) ([]*domain.User, error) {
	rows, err := queries(ctx, r.db).ListUsers(ctx, sqlitedb.ListUsersParams{
		Keyword: sqliteKeywordPattern(in.Keyword), Role: string(in.Role), Status: string(in.Status),
		RowOffset: int64(in.Page.Offset), PageSize: int64(in.Page.Limit),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	out := make([]*domain.User, 0, len(rows))
	for _, row := range rows {
		v, err := mapSQLiteUser(row)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (r *UserRepository) CountFiltered(ctx context.Context, in domain.ListUsersInput) (int64, error) {
	v, err := queries(ctx, r.db).CountUsersFiltered(ctx, sqlitedb.CountUsersFilteredParams{
		Keyword: sqliteKeywordPattern(in.Keyword), Role: string(in.Role), Status: string(in.Status),
	})
	return v, mapSQLiteError(err)
}

func (r *UserRepository) UpdateProfile(ctx context.Context, in domain.UpdateProfileInput) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) {
		return q.UpdateUserProfile(ctx, sqlitedb.UpdateUserProfileParams{
			Nickname: in.Nickname, AvatarUrl: in.AvatarURL, UpdatedAt: sqliteTime(in.Now), Uid: in.UID,
		})
	})
}

func (r *UserRepository) UpdateEmail(ctx context.Context, uid, email string, now time.Time) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) {
		return q.UpdateUserEmail(ctx, sqlitedb.UpdateUserEmailParams{
			Email: email, UpdatedAt: sqliteTime(now), Uid: uid,
		})
	})
}

func (r *UserRepository) UpdatePassword(ctx context.Context, id int64, passwordHash string, now time.Time) error {
	affected, err := queries(ctx, r.db).UpdateUserPassword(ctx, sqlitedb.UpdateUserPasswordParams{
		PasswordHash: passwordHash, UpdatedAt: sqliteTime(now), ID: id,
	})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *UserRepository) UpdateStatus(ctx context.Context, uid string, status domain.UserStatus, now time.Time) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) {
		return q.UpdateUserStatus(ctx, sqlitedb.UpdateUserStatusParams{Status: string(status), UpdatedAt: sqliteTime(now), Uid: uid})
	})
}

func (r *UserRepository) UpdateRole(ctx context.Context, uid string, role domain.Role, now time.Time) (*domain.User, error) {
	return r.user(ctx, func(q *sqlitedb.Queries) (sqlitedb.User, error) {
		return q.UpdateUserRole(ctx, sqlitedb.UpdateUserRoleParams{Role: string(role), UpdatedAt: sqliteTime(now), Uid: uid})
	})
}

func (r *UserRepository) TouchLastLogin(ctx context.Context, id int64, at time.Time) error {
	affected, err := queries(ctx, r.db).TouchUserLastLogin(ctx, sqlitedb.TouchUserLastLoginParams{
		LastLoginAt: sqliteRequiredNullableTime(at), UpdatedAt: sqliteTime(at), ID: id,
	})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *UserRepository) SoftDelete(ctx context.Context, uid string, now time.Time) error {
	affected, err := queries(ctx, r.db).SoftDeleteUser(ctx, sqlitedb.SoftDeleteUserParams{
		DeletedAt: sqliteRequiredNullableTime(now), UpdatedAt: sqliteTime(now), Uid: uid,
	})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *UserRepository) IncrementMapCount(ctx context.Context, id int64, delta int, now time.Time) error {
	affected, err := queries(ctx, r.db).IncrementUserMapCount(ctx, sqlitedb.IncrementUserMapCountParams{
		Delta: int64(delta), UpdatedAt: sqliteTime(now), ID: id,
	})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *MapRepository) Create(ctx context.Context, in domain.CreateMapInput) (*domain.Map, error) {
	v, err := queries(ctx, r.db).CreateMap(ctx, sqlitedb.CreateMapParams{
		Uid: in.UID, OwnerID: in.OwnerID, Title: in.Title, Document: string(in.Document),
		NodeCount: int64(in.NodeCount), SizeBytes: in.SizeBytes,
		CreatedAt: sqliteTime(in.Now), UpdatedAt: sqliteTime(in.Now),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMap(v)
}

func (r *MapRepository) GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.Map, error) {
	v, err := queries(ctx, r.db).GetMapByUID(ctx, sqlitedb.GetMapByUIDParams{Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMap(v)
}

func (r *MapRepository) GetForUpdate(ctx context.Context, uid string, ownerID int64) (*domain.Map, error) {
	if _, ok := domain.TxHandle(ctx); !ok {
		return nil, errors.New("GetForUpdate requires an active transaction")
	}
	v, err := queries(ctx, r.db).GetMapForUpdate(ctx, sqlitedb.GetMapForUpdateParams{Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMap(v)
}

func (r *MapRepository) ListByOwner(ctx context.Context, ownerID int64, page domain.Page) ([]*domain.Map, error) {
	rows, err := queries(ctx, r.db).ListMapsByOwner(ctx, sqlitedb.ListMapsByOwnerParams{
		OwnerID: ownerID, RowOffset: int64(page.Offset), PageSize: int64(page.Limit),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMaps(rows)
}

func (r *MapRepository) CountByOwner(ctx context.Context, ownerID int64) (int64, error) {
	v, err := queries(ctx, r.db).CountMapsByOwner(ctx, ownerID)
	return v, mapSQLiteError(err)
}

func (r *MapRepository) SearchByTitle(ctx context.Context, ownerID int64, pattern string, page domain.Page) ([]*domain.Map, error) {
	rows, err := queries(ctx, r.db).SearchMapsByTitle(ctx, sqlitedb.SearchMapsByTitleParams{
		OwnerID: ownerID, Pattern: pattern, RowOffset: int64(page.Offset), PageSize: int64(page.Limit),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMaps(rows)
}

func (r *MapRepository) CountByTitle(ctx context.Context, ownerID int64, pattern string) (int64, error) {
	v, err := queries(ctx, r.db).CountMapsByTitle(ctx, sqlitedb.CountMapsByTitleParams{OwnerID: ownerID, Pattern: pattern})
	return v, mapSQLiteError(err)
}

func (r *MapRepository) UpdateWithVersion(ctx context.Context, in domain.UpdateMapInput) (*domain.Map, error) {
	v, err := queries(ctx, r.db).UpdateMapWithVersion(ctx, sqlitedb.UpdateMapWithVersionParams{
		Title: in.Title, Document: string(in.Document), ThumbnailUrl: in.ThumbnailURL,
		NodeCount: int64(in.NodeCount), SizeBytes: in.SizeBytes, UpdatedAt: sqliteTime(in.Now),
		Uid: in.UID, OwnerID: in.OwnerID, ExpectedVersion: int64(in.ExpectedVersion),
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			if _, getErr := r.GetByUID(ctx, in.UID, in.OwnerID); getErr == nil {
				return nil, domain.ErrVersionConflict
			} else if errors.Is(getErr, domain.ErrNotFound) {
				return nil, domain.ErrNotFound
			} else {
				return nil, getErr
			}
		}
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMap(v)
}

func (r *MapRepository) UpdateMeta(ctx context.Context, uid string, ownerID int64, title string, now time.Time) (*domain.Map, error) {
	v, err := queries(ctx, r.db).UpdateMapMeta(ctx, sqlitedb.UpdateMapMetaParams{
		Title: title, UpdatedAt: sqliteTime(now), Uid: uid, OwnerID: ownerID,
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMap(v)
}

func (r *MapRepository) UpdateThumbnail(ctx context.Context, uid string, ownerID int64, thumbnailURL string, now time.Time) error {
	affected, err := queries(ctx, r.db).UpdateMapThumbnail(ctx, sqlitedb.UpdateMapThumbnailParams{
		ThumbnailUrl: thumbnailURL, UpdatedAt: sqliteTime(now), Uid: uid, OwnerID: ownerID,
	})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *MapRepository) SoftDelete(ctx context.Context, uid string, ownerID int64, now time.Time) error {
	affected, err := queries(ctx, r.db).SoftDeleteMap(ctx, sqlitedb.SoftDeleteMapParams{
		DeletedAt: sqliteRequiredNullableTime(now), UpdatedAt: sqliteTime(now), Uid: uid, OwnerID: ownerID,
	})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *MapRepository) Restore(ctx context.Context, uid string, ownerID int64, now time.Time) (*domain.Map, error) {
	v, err := queries(ctx, r.db).RestoreMap(ctx, sqlitedb.RestoreMapParams{UpdatedAt: sqliteTime(now), Uid: uid, OwnerID: ownerID})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMap(v)
}

func (r *MapRepository) ListTrashed(ctx context.Context, ownerID int64, page domain.Page) ([]*domain.Map, error) {
	rows, err := queries(ctx, r.db).ListTrashedMaps(ctx, sqlitedb.ListTrashedMapsParams{
		OwnerID: ownerID, RowOffset: int64(page.Offset), PageSize: int64(page.Limit),
	})
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMaps(rows)
}

func (r *MapRepository) CountTrashed(ctx context.Context, ownerID int64) (int64, error) {
	v, err := queries(ctx, r.db).CountTrashedMaps(ctx, ownerID)
	return v, mapSQLiteError(err)
}

func (r *MapRepository) HardDelete(ctx context.Context, uid string, ownerID int64) error {
	affected, err := queries(ctx, r.db).HardDeleteMap(ctx, sqlitedb.HardDeleteMapParams{Uid: uid, OwnerID: ownerID})
	return mapSQLiteRowsAffected(affected, err)
}

func (r *MapRepository) HardDeleteTrashed(ctx context.Context, ownerID int64) error {
	return mapSQLiteError(queries(ctx, r.db).HardDeleteTrashedMaps(ctx, ownerID))
}

func (r *MapRepository) ListAllIncludingDeleted(ctx context.Context, ownerID int64) ([]*domain.Map, error) {
	rows, err := queries(ctx, r.db).ListAllMapsByOwnerIncludingDeleted(ctx, ownerID)
	if err != nil {
		return nil, mapSQLiteError(err)
	}
	return mapSQLiteMaps(rows)
}

func mapSQLiteMaps(rows []sqlitedb.Map) ([]*domain.Map, error) {
	out := make([]*domain.Map, 0, len(rows))
	for _, row := range rows {
		v, err := mapSQLiteMap(row)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

var _ domain.UserRepo = (*UserRepository)(nil)
var _ domain.MapRepo = (*MapRepository)(nil)
var _ domain.TxManager = (*TransactionManager)(nil)
