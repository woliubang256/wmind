// Package credstore 把云端连接凭据存进本地数据库。
//
// 为什么不用系统钥匙串：桌面端是 ad-hoc 签名的自构建应用，每次更新后签名变化，
// macOS 会把它当成「另一个应用」读取钥匙串条目，于是每次升级都要重新授权、
// 甚至重新登录。凭据本来就是「本机这一份数据库」的一部分，跟着数据目录走更符合
// 预期：重装应用只要不删数据目录就还在。
//
// 存储形态与原来的 cloud.json 一致：JSON 结构 + AES-GCM 加密的密码，主密钥来自
// 本机 secrets.json（0600）。数据库被单独拷走也解不出密码。
package credstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloudcreds"
)

const credentialKey = "cloud-connection"

// Store 读写 desktop_secrets 表里的凭据记录。
type Store struct {
	db     *sql.DB
	secret string
}

// Prepare 建表。桌面端自己的 schema 走 bootstrap 的 Prepare 钩子，不进迁移集。
func Prepare(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS desktop_secrets (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	if err != nil {
		return fmt.Errorf("create desktop_secrets: %w", err)
	}
	return nil
}

// New 构造存储。
func New(db *sql.DB, secret string) *Store {
	return &Store{db: db, secret: secret}
}

// Load 读取凭据；没有连接时返回 (nil, nil)。
func (s *Store) Load() (*cloudcreds.Credentials, error) {
	var raw string
	err := s.db.QueryRowContext(context.Background(),
		`SELECT value FROM desktop_secrets WHERE key = ?`, credentialKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return cloudcreds.Decode(raw, s.secret)
}

// Save 写入凭据（密码加密后落库）。
func (s *Store) Save(creds cloudcreds.Credentials, password string) error {
	encoded, err := cloudcreds.Encode(creds, password, s.secret)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(context.Background(),
		`INSERT INTO desktop_secrets (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		credentialKey, encoded)
	return err
}

// Clear 删除凭据。
func (s *Store) Clear() error {
	_, err := s.db.ExecContext(context.Background(),
		`DELETE FROM desktop_secrets WHERE key = ?`, credentialKey)
	return err
}
