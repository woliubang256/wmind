// Package localmode 是桌面端「本地模式」的装配：数据目录、本地密钥、
// 本地用户身份与后端配置。
//
// 本地模式不登录，但仍走与 Web 完全相同的 API 与权限链路：这里创建一个
// 固定的本地管理员用户，并签发一个长期访问令牌注入页面。这样 service 与
// handler 不需要为桌面端分叉，管理后台（AI 配置、备份配置）也能直接用。
package localmode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/domain"
	idgen "github.com/woliubang256/wmind/backend/internal/pkg/id"
)

// LocalEmail 是本地用户的固定邮箱。它不是真实地址，只用于在本地库里定位
// 这一个账号；登录接口对它是关闭的（密码是随机值，谁也不持有）。
const LocalEmail = "local@wmind.local"

// LocalUsername 是本地用户的用户名。
const LocalUsername = "local"

// accessTokenTTL 是本地访问令牌的有效期。
//
// 本地模式没有登录页，令牌只在进程启动时签发一次并注入页面。取十年是为了
// 让「长期开着窗口的用户」不会因为令牌过期被踢回登录页——刷新链路在桌面
// 本地模式里没有意义（没有远端会话）。
const accessTokenTTL = 10 * 365 * 24 * time.Hour

// Paths 是本地模式的数据目录。
type Paths struct {
	// Root 是应用数据根目录。
	Root string
	// Database 是 SQLite 文件。
	Database string
	// Uploads 是图片与缩略图目录。
	Uploads string
	// Secrets 是本地密钥文件。
	Secrets string
}

// ResolvePaths 计算本地数据目录，并确保它们存在。
func ResolvePaths(userData string) (Paths, error) {
	p := Paths{
		Root:     userData,
		Database: filepath.Join(userData, "wmind.db"),
		Uploads:  filepath.Join(userData, "uploads"),
		Secrets:  filepath.Join(userData, "secrets.json"),
	}
	for _, dir := range []string{p.Root, p.Uploads} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return Paths{}, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	return p, nil
}

// Secrets 是本地模式需要跨启动保持的密钥。
//
// 必须持久化：JWT 密钥每次启动都变会让已注入页面的令牌立刻失效；AI 配置
// 的加密密钥由它派生，变了就读不回原来的 API Key。
type Secrets struct {
	// JWTSecret 是访问令牌与配置加密共用的主密钥（十六进制，≥ 32 字节）。
	JWTSecret string `json:"jwtSecret"`
}

// LoadSecrets 读取本地密钥，缺失时生成一份并落盘（0600）。
func LoadSecrets(path string) (*Secrets, error) {
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		var s Secrets
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		if len(s.JWTSecret) < 64 {
			return nil, fmt.Errorf("%s: jwtSecret is missing or too short", path)
		}
		return &s, nil
	case errors.Is(err, os.ErrNotExist):
		s, err := generateSecrets()
		if err != nil {
			return nil, err
		}
		if err := writeSecrets(path, s); err != nil {
			return nil, err
		}
		return s, nil
	default:
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
}

func generateSecrets() (*Secrets, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("generate jwt secret: %w", err)
	}
	return &Secrets{JWTSecret: hex.EncodeToString(buf)}, nil
}

func writeSecrets(path string, s *Secrets) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	// 0600：这个文件能解密 AI API Key，不能让同机其他用户读到。
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// Config 构造后端配置：SQLite + 本地存储目录 + 本地密钥。
func Config(p Paths, s *Secrets) *config.Config {
	return &config.Config{
		Env:         config.EnvDevelopment,
		Addr:        "127.0.0.1:0",
		LogLevel:    "info",
		AutoMigrate: true,
		DB: config.DB{
			Driver:     config.DriverSQLite,
			SQLitePath: p.Database,
		},
		Auth: config.Auth{
			JWTSecret: s.JWTSecret,
		},
		Storage: config.Storage{Dir: p.Uploads},
	}
}

// EnsureUser 返回本地用户，不存在时创建一个管理员。
//
// 必须是管理员：AI 与备份配置的接口挂在管理后台权限下，本地模式要让用户
// 直接可用。密码是随机值且从不保存，因此无法通过登录接口拿到这个账号。
func EnsureUser(ctx context.Context, repo domain.UserRepo, now time.Time) (*domain.User, error) {
	user, err := repo.GetByEmail(ctx, LocalEmail)
	if err == nil {
		return user, nil
	}
	if !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}

	random, err := randomPassword()
	if err != nil {
		return nil, err
	}
	hash, err := auth.HashPassword(random)
	if err != nil {
		return nil, err
	}
	created, err := repo.Create(ctx, domain.CreateUserInput{
		UID:          idgen.New(),
		Username:     LocalUsername,
		Email:        LocalEmail,
		PasswordHash: hash,
		Nickname:     "本地用户",
		Role:         domain.RoleAdmin,
		Status:       domain.UserStatusActive,
		Now:          now.UTC(),
	})
	if err != nil {
		return nil, fmt.Errorf("create local user: %w", err)
	}
	return created, nil
}

// Token 为本地用户签发访问令牌。
func Token(secret string, user *domain.User) (string, error) {
	issuer, err := auth.NewTokenIssuer(secret, accessTokenTTL)
	if err != nil {
		return "", err
	}
	token, _, err := issuer.Issue(user.UID, string(user.Role))
	return token, err
}

func randomPassword() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
