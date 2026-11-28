// Package mapsource 记录「这张本机导图来自哪个本地文件」。
//
// 为什么需要它：用户双击一个 `.wmind` / `.xmind` 文件，应用把它转成一张本机
// 导图；之后再双击同一个文件，期望的是**打开那张导图**，而不是堆出一张又一张
// 同名副本。要做到这点，就得有一个「来源文件路径 → 导图 uid」的反查。
//
// 为什么单独一张表而不是塞进 `map_sync`：`map_sync` 描述的是「本机导图 ↔ 云端
// 导图」的同步状态，来源路径与云端毫无关系。两者混在一起，会让「从本机文件
// 导入」看起来像一次同步事件，也会让清空同步状态时误删来源记录。
//
// 这张表只存在于桌面端，因此和服务端的迁移集无关——和服务端 schema 的 parity
// 门禁也无关（同 `map_sync`，见 internal/syncstate 的说明）。
package mapsource

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/pkg/timeutil"
)

// Schema 是这张表的建表语句。只用 SQLite 语法：桌面端固定用 SQLite。
const Schema = `
CREATE TABLE IF NOT EXISTS map_source (
  map_uid    TEXT    PRIMARY KEY,
  path       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  mod_time   TEXT,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_source_path ON map_source(path);
`

// Record 是一条来源记录。
type Record struct {
	// MapUID 是本机导图的 uid。
	MapUID string
	// Path 是来源文件的绝对路径（已规范化，见 Normalize）。
	Path string
	// Name 是文件名，列表与提示里显示。
	Name string
	// Size 与 ModTime 是记录时文件的元信息，用来提示「文件已改过」。
	Size    int64
	ModTime *time.Time
	// CreatedAt 是记录时间。
	CreatedAt time.Time
}

// Prepare 建表。作为 bootstrap.Options.Prepare 传给装配层，与 map_sync 同批。
func Prepare(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, Schema); err != nil {
		return fmt.Errorf("create map_source: %w", err)
	}
	return nil
}

// Normalize 把用户/系统给的路径规范化成可比对的绝对路径。
//
// 只做 `Clean` + `Abs`：**不做** EvalSymlinks 或大小写折叠。桌面端三平台里，
// 符号链接解析会在网络盘、挂载点上失败；macOS 的卷默认大小写不敏感，但用户也
// 可能开大小写敏感卷。用「系统给的路径原样比较」换取可预测，同一个文件通过
// 不同路径（例如 /tmp 与 /private/tmp）打开时最多多出一张副本，不会认错文件。
func Normalize(path string) (string, error) {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "" || cleaned == "." {
		return "", errors.New("mapsource: empty path")
	}
	return filepath.Abs(cleaned)
}

// Store 读写来源记录。
type Store struct {
	db *sql.DB
}

// NewStore 构造 Store。调用方需先执行 Prepare（bootstrap 的 Prepare 钩子）。
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ErrNotFound 表示这份导图没有来源记录（不是从本地文件打开的）。
var ErrNotFound = errors.New("source record not found")

// Get 按导图 uid 读取来源记录。
func (s *Store) Get(ctx context.Context, mapUID string) (*Record, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT map_uid, path, name, size, mod_time, created_at
FROM map_source WHERE map_uid = ?`, mapUID)
	return scanRecord(row)
}

// ByPath 按来源路径反查导图。
func (s *Store) ByPath(ctx context.Context, path string) (*Record, error) {
	normalized, err := Normalize(path)
	if err != nil {
		return nil, err
	}
	row := s.db.QueryRowContext(ctx, `
SELECT map_uid, path, name, size, mod_time, created_at
FROM map_source WHERE path = ?`, normalized)
	return scanRecord(row)
}

// Put 写入或覆盖一份来源记录。
func (s *Store) Put(ctx context.Context, rec *Record) error {
	if rec == nil {
		return errors.New("mapsource: nil record")
	}
	if rec.MapUID == "" {
		return errors.New("mapsource: map uid is required")
	}
	normalized, err := Normalize(rec.Path)
	if err != nil {
		return err
	}
	if rec.Name == "" {
		rec.Name = filepath.Base(normalized)
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now().UTC()
	}
	var modTime any
	if rec.ModTime != nil {
		modTime = timeutil.Format(rec.ModTime.UTC())
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin map_source upsert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM map_source WHERE path = ? AND map_uid <> ?`, normalized, rec.MapUID); err != nil {
		return fmt.Errorf("replace map_source path: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO map_source (map_uid, path, name, size, mod_time, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(map_uid) DO UPDATE SET
  path = excluded.path,
  name = excluded.name,
  size = excluded.size,
  mod_time = excluded.mod_time`,
		rec.MapUID, normalized, rec.Name, rec.Size, modTime, timeutil.Format(rec.CreatedAt.UTC()))
	if err != nil {
		return fmt.Errorf("upsert map_source: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit map_source upsert: %w", err)
	}
	rec.Path = normalized
	return nil
}

// Delete 删除一份来源记录（导图被彻底删除时调用）。
func (s *Store) Delete(ctx context.Context, mapUID string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM map_source WHERE map_uid = ?`, mapUID); err != nil {
		return fmt.Errorf("delete map_source: %w", err)
	}
	return nil
}

// DeleteAll removes all source bindings after permanent empty-trash cleanup.
func (s *Store) DeleteAll(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM map_source`); err != nil {
		return fmt.Errorf("delete all map_source: %w", err)
	}
	return nil
}

// Exists 报告来源文件现在是否还在。界面据此决定要不要显示「打开文件所在目录」。
func Exists(rec *Record) bool {
	if rec == nil || rec.Path == "" {
		return false
	}
	info, err := os.Stat(rec.Path)
	return err == nil && !info.IsDir()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanRecord(src scanner) (*Record, error) {
	var (
		rec       Record
		modTime   sql.NullString
		createdAt string
	)
	err := src.Scan(&rec.MapUID, &rec.Path, &rec.Name, &rec.Size, &modTime, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if modTime.Valid && modTime.String != "" {
		at, err := timeutil.Parse(modTime.String)
		if err != nil {
			return nil, fmt.Errorf("parse mod_time: %w", err)
		}
		rec.ModTime = &at
	}
	at, err := timeutil.Parse(createdAt)
	if err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	rec.CreatedAt = at
	return &rec, nil
}
