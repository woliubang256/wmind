// Package credstore 把云端连接凭据存进本地数据库。
//
// 为什么不用系统钥匙串：桌面端是 ad-hoc 签名的自构建应用，每次更新后签名变化，
// macOS 会把它当成「另一个应用」读取钥匙串条目，于是每次升级都要重新授权、
// 甚至重新登录。凭据本来就是「本机这一份数据库」的一部分，跟着数据目录走更符合
// 预期：重装应用只要不删数据目录就还在。
//
// 保存版本化 JSON 与 AES-GCM 加密的刷新令牌，主密钥来自本机 secrets.json
// （0600）。不保存账号密码或访问令牌，数据库单独被拷走不能恢复登录凭据。
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

// Save encrypts the refresh credential before writing it to the database.
func (s *Store) Save(creds cloudcreds.Credentials) error {
	encoded, err := cloudcreds.Encode(creds, s.secret)
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
