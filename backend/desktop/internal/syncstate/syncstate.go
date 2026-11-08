// Package syncstate 保存「本机导图 ↔ 云端导图」的同步状态。
//
// 这张表只存在于桌面端，因此不进服务端的迁移集（那会让 Web 侧多出无用的
// 表，还要维护两套方言的 parity）。桌面端在启动时用 CREATE TABLE IF NOT
// EXISTS 建它，见 Schema。
package syncstate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/pkg/timeutil"
)

// State 是同步状态机的取值。
type State string

const (
	// StateLocalOnly 表示只在本机，从未上传。
	StateLocalOnly State = "local-only"
	// StateSynced 表示本机与云端一致。
	StateSynced State = "synced"
	// StateLocalDirty 表示本机有未上传的修改。
	StateLocalDirty State = "local-dirty"
	// StateRemoteDirty 表示云端有本机还没拉取的修改。
	StateRemoteDirty State = "remote-dirty"
	// StateConflict 表示两端都改过，需要用户处理。
	StateConflict State = "conflict"
	// StateOffline 表示上次同步失败（网络或服务端不可用）。
	StateOffline State = "offline"
)

// Valid 报告 s 是否为已知状态。
func (s State) Valid() bool {
	switch s {
	case StateLocalOnly, StateSynced, StateLocalDirty, StateRemoteDirty, StateConflict, StateOffline:
		return true
	default:
		return false
	}
}

// Record 是一条同步记录。
type Record struct {
	// MapUID 是本机导图的 uid。
	MapUID string
	// RemoteUID 是云端导图的 uid。本机上传时两者相同；从云端「下载为本地
	// 副本」时不同——那是一次独立复制，之后各走各的。
	RemoteUID string
	// RemoteURL 是这份记录属于哪个云端服务器。同一份本地导图只能绑定一个
	// 云端来源，换服务器等于换绑定。
	RemoteURL string
	// BaseVersion 是上次成功同步时的云端版本号。
	BaseVersion int
	// BaseHash 是上次成功同步时云端内容的 SHA-256 摘要。
	BaseHash string
	// BaseLocalHash 是上次成功同步时**本地**内容的 SHA-256 摘要。
	//
	// 判断「本机有没有改动」靠它，而不是靠本地版本号：本地版本号在每次
	// 保存时自增，但同步一次可能写入两次（先拉后推），用版本号比对会误判。
	BaseLocalHash string
	// LastSyncedAt 为空表示从未成功同步。
	LastSyncedAt *time.Time
	// Deleted 表示这份导图在两端都已删除。
	//
	// 本地回收站里的导图仍保留记录：恢复之后要能重新同步，所以不能把记录
	// 删掉。用这个标记区分「已经两边都删了」与「本地刚删、还没推上去」。
	Deleted bool
	// State 是当前状态。
	State State
	// UpdatedAt 是这条记录本身的最后修改时间。
	UpdatedAt time.Time
}

// Schema 是桌面端自己的表结构。
//
// 只用 SQLite 语法：桌面端固定用 SQLite（见 localmode.Config）。
const Schema = `
CREATE TABLE IF NOT EXISTS map_sync (
  map_uid        TEXT    PRIMARY KEY,
  remote_uid     TEXT    NOT NULL DEFAULT '',
  remote_url     TEXT    NOT NULL DEFAULT '',
  base_version   INTEGER NOT NULL DEFAULT 0,
  base_hash      TEXT    NOT NULL DEFAULT '',
  base_local_hash TEXT   NOT NULL DEFAULT '',
  last_synced_at TEXT,
  state          TEXT    NOT NULL DEFAULT 'local-only',
  deleted        INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_sync_remote ON map_sync(remote_url, remote_uid);
CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

// MetaLastPullAt 是增量拉取游标的键。
const MetaLastPullAt = "last_pull_at"

// Prepare 建表并补齐后续版本新增的列。作为 bootstrap.Options.Prepare 传给装配层。
//
// 桌面端的表不进服务端迁移集，所以升级靠这里的「加列」步骤：ALTER TABLE
// ADD COLUMN 在 SQLite 上重复执行会报 duplicate column name，忽略即可。
func Prepare(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, Schema); err != nil {
		return fmt.Errorf("create map_sync: %w", err)
	}
	for _, stmt := range []string{
		`ALTER TABLE map_sync ADD COLUMN base_local_hash TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE map_sync ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("upgrade map_sync: %w", err)
		}
	}
	return nil
}

// Store 读写同步记录。
type Store struct {
	db *sql.DB
}

// NewStore 构造 Store。调用方需先执行 Prepare（bootstrap 的 Prepare 钩子）。
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ErrNotFound 表示没有该导图的同步记录（从未上传）。
var ErrNotFound = errors.New("sync record not found")

// Get 读取一条记录。
func (s *Store) Get(ctx context.Context, mapUID string) (*Record, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT map_uid, remote_uid, remote_url, base_version, base_hash, base_local_hash, last_synced_at, state, deleted, updated_at
FROM map_sync WHERE map_uid = ?`, mapUID)
	return scanRecord(row)
}

// ByRemote 按云端地址 + 云端 uid 反查本机记录。
func (s *Store) ByRemote(ctx context.Context, remoteURL, remoteUID string) (*Record, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT map_uid, remote_uid, remote_url, base_version, base_hash, base_local_hash, last_synced_at, state, deleted, updated_at
FROM map_sync WHERE remote_url = ? AND remote_uid = ?`, remoteURL, remoteUID)
	return scanRecord(row)
}

// List 返回全部记录，按更新时间升序。
func (s *Store) List(ctx context.Context) ([]*Record, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT map_uid, remote_uid, remote_url, base_version, base_hash, base_local_hash, last_synced_at, state, deleted, updated_at
FROM map_sync ORDER BY updated_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*Record
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// Put 写入或覆盖一条记录。
func (s *Store) Put(ctx context.Context, rec *Record) error {
	if rec == nil {
		return errors.New("syncstate: nil record")
	}
	if rec.MapUID == "" {
		return errors.New("syncstate: map uid is required")
	}
	if rec.State == "" {
		rec.State = StateLocalOnly
	}
	if !rec.State.Valid() {
		return fmt.Errorf("syncstate: unknown state %q", rec.State)
	}
	if rec.UpdatedAt.IsZero() {
		rec.UpdatedAt = time.Now().UTC()
	}
	var lastSynced any
	if rec.LastSyncedAt != nil {
		lastSynced = timeutil.Format(rec.LastSyncedAt.UTC())
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO map_sync (map_uid, remote_uid, remote_url, base_version, base_hash, base_local_hash, last_synced_at, state, deleted, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(map_uid) DO UPDATE SET
  remote_uid = excluded.remote_uid,
  remote_url = excluded.remote_url,
  base_version = excluded.base_version,
  base_hash = excluded.base_hash,
  base_local_hash = excluded.base_local_hash,
  last_synced_at = excluded.last_synced_at,
  state = excluded.state,
  deleted = excluded.deleted,
  updated_at = excluded.updated_at`,
		rec.MapUID, rec.RemoteUID, rec.RemoteURL, rec.BaseVersion, rec.BaseHash, rec.BaseLocalHash,
		lastSynced, string(rec.State), rec.Deleted, timeutil.Format(rec.UpdatedAt.UTC()))
	if err != nil {
		return fmt.Errorf("upsert map_sync: %w", err)
	}
	return nil
}

// Delete 删除一条记录（导图被彻底删除时调用）。
func (s *Store) Delete(ctx context.Context, mapUID string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM map_sync WHERE map_uid = ?`, mapUID); err != nil {
		return fmt.Errorf("delete map_sync: %w", err)
	}
	return nil
}

// scanner 让 QueryRow 与 Rows 共用一套扫描逻辑。
type scanner interface {
	Scan(dest ...any) error
}

func scanRecord(src scanner) (*Record, error) {
	var (
		rec        Record
		lastSynced sql.NullString
		state      string
		updatedAt  string
	)
	var deleted bool
	err := src.Scan(&rec.MapUID, &rec.RemoteUID, &rec.RemoteURL, &rec.BaseVersion,
		&rec.BaseHash, &rec.BaseLocalHash, &lastSynced, &state, &deleted, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rec.State = State(state)
	rec.Deleted = deleted
	if lastSynced.Valid && lastSynced.String != "" {
		at, err := timeutil.Parse(lastSynced.String)
		if err != nil {
			return nil, fmt.Errorf("parse last_synced_at: %w", err)
		}
		rec.LastSyncedAt = &at
	}
	at, err := timeutil.Parse(updatedAt)
	if err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	rec.UpdatedAt = at
	return &rec, nil
}

// GetMeta 读取一个元数据值，缺失时返回空串。
func (s *Store) GetMeta(ctx context.Context, key string) (string, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM sync_meta WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return value, nil
}

// SetMeta 写入一个元数据值。
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO sync_meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	if err != nil {
		return fmt.Errorf("upsert sync_meta: %w", err)
	}
	return nil
}
