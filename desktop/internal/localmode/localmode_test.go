package localmode

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	sqliterepo "github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

func openRepo(t *testing.T) domain.UserRepo {
	t.Helper()
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "wmind.db"))
	if err != nil {
		t.Fatalf("打开 SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := migrate.Up(config.DriverSQLite, db, testLogger()); err != nil {
		t.Fatalf("迁移失败: %v", err)
	}
	return sqliterepo.NewUserRepository(db)
}

// 本地用户必须可重复获取：每次启动都会调用 EnsureUser，重复创建会撞唯一约束。
func TestEnsureUserIsIdempotent(t *testing.T) {
	repo := openRepo(t)
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)

	first, err := EnsureUser(context.Background(), repo, now)
	if err != nil {
		t.Fatalf("创建本地用户失败: %v", err)
	}
	if first.Email != LocalEmail || first.Role != domain.RoleAdmin || !first.IsActive() {
		t.Fatalf("本地用户属性不符合预期: %+v", first)
	}

	second, err := EnsureUser(context.Background(), repo, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("再次获取本地用户失败: %v", err)
	}
	if second.UID != first.UID {
		t.Fatalf("应当是同一个用户: %s != %s", second.UID, first.UID)
	}
}

// 本地令牌必须能被后端的鉴权链路解析，否则窗口里的每个请求都会 401。
func TestTokenIsAcceptedByIssuer(t *testing.T) {
	secrets := &Secrets{JWTSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
	user := &domain.User{UID: "user-1", Role: domain.RoleAdmin}

	token, err := Token(secrets.JWTSecret, user)
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	issuer, err := auth.NewTokenIssuer(secrets.JWTSecret, accessTokenTTL)
	if err != nil {
		t.Fatalf("构造签发器失败: %v", err)
	}
	claims, err := issuer.Parse(token)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if claims.Subject != user.UID || claims.Role != string(domain.RoleAdmin) {
		t.Fatalf("声明不符合预期: %+v", claims)
	}
}

// 密钥必须跨启动保持：变了的话已注入页面的令牌立刻失效，AI 配置也解不开。
func TestLoadSecretsPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")

	first, err := LoadSecrets(path)
	if err != nil {
		t.Fatalf("首次生成失败: %v", err)
	}
	if len(first.JWTSecret) < 64 {
		t.Fatalf("密钥过短: %q", first.JWTSecret)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("密钥文件没有落盘: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("密钥文件权限应为 0600，实际 %v", info.Mode().Perm())
	}

	second, err := LoadSecrets(path)
	if err != nil {
		t.Fatalf("再次读取失败: %v", err)
	}
	if second.JWTSecret != first.JWTSecret {
		t.Fatal("密钥在两次启动之间发生了变化")
	}
}

func TestLoadSecretsRejectsCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSecrets(path); err == nil {
		t.Fatal("损坏的密钥文件应当报错，而不是静默重新生成")
	}

	if err := os.WriteFile(path, []byte(`{"jwtSecret":"short"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSecrets(path); err == nil {
		t.Fatal("过短的密钥应当报错")
	}
}

// 本地模式的配置必须落在用户数据目录，且不需要任何环境变量。
func TestConfigPointsAtLocalData(t *testing.T) {
	root := t.TempDir()
	paths, err := ResolvePaths(root)
	if err != nil {
		t.Fatalf("解析路径失败: %v", err)
	}
	if _, err := os.Stat(paths.Uploads); err != nil {
		t.Fatalf("上传目录没有创建: %v", err)
	}

	cfg := Config(paths, &Secrets{JWTSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"})
	if cfg.DB.Driver != config.DriverSQLite {
		t.Fatalf("桌面本地模式必须是 SQLite，实际 %q", cfg.DB.Driver)
	}
	if cfg.DB.SQLitePath != paths.Database || cfg.Storage.Dir != paths.Uploads {
		t.Fatalf("路径没有落在用户数据目录: %+v", cfg)
	}
	if !cfg.AutoMigrate {
		t.Fatal("本地库必须自动迁移，否则首次启动就不可用")
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
