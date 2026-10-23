package config

import (
	"strings"
	"testing"
)

// 每个用例都把相关环境变量显式设置或置空，避免受开发机上的 .env 影响。
// Viper 默认把「空字符串」当作未设置，因此置空等价于回落到默认值。

func TestLoadRejectsShortJWTSecret(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", "too-short")

	_, err := Load()
	if err == nil {
		t.Fatal("短密钥应当导致启动失败，实际通过了校验")
	}
	if !strings.Contains(err.Error(), "WMIND_JWT_SECRET") {
		t.Fatalf("错误信息应点名具体变量，实际为: %v", err)
	}
}

func TestLoadAcceptsMinimumLengthJWTSecret(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", strings.Repeat("a", minJWTSecretLen))

	cfg, err := Load()
	if err != nil {
		t.Fatalf("恰好 %d 字节的密钥应被接受，实际报错: %v", minJWTSecretLen, err)
	}
	if len(cfg.Auth.JWTSecret) != minJWTSecretLen {
		t.Fatalf("密钥未被正确读取: %d", len(cfg.Auth.JWTSecret))
	}
}

func TestLoadRejectsUnknownDriver(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", strings.Repeat("a", 48))
	t.Setenv("WMIND_DB_DRIVER", "mysql")

	_, err := Load()
	if err == nil {
		t.Fatal("未知驱动应当导致启动失败")
	}
	if !strings.Contains(err.Error(), "WMIND_DB_DRIVER") {
		t.Fatalf("错误信息应点名驱动变量，实际为: %v", err)
	}
}

func TestLoadRequiresDatabaseURLOnlyForPostgres(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", strings.Repeat("a", 48))

	// SQLite 下不需要连接串。
	t.Setenv("WMIND_DB_DRIVER", "sqlite")
	t.Setenv("WMIND_DATABASE_URL", "")
	if _, err := Load(); err != nil {
		t.Fatalf("sqlite 驱动不应要求 WMIND_DATABASE_URL，实际报错: %v", err)
	}

	// PostgreSQL 下缺失连接串必须失败——这是条件必填的语义。
	t.Setenv("WMIND_DB_DRIVER", "postgres")
	if _, err := Load(); err == nil {
		t.Fatal("postgres 驱动缺少 WMIND_DATABASE_URL 时应当失败")
	}
}

func TestLoadDefaultsToSQLite(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", strings.Repeat("a", 48))
	for _, key := range []string{"WMIND_DB_DRIVER", "WMIND_ENV", "WMIND_SQLITE_PATH"} {
		t.Setenv(key, "")
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("默认配置应当可用，实际报错: %v", err)
	}
	if cfg.DB.Driver != DriverSQLite {
		t.Errorf("默认驱动应为 %q，实际 %q", DriverSQLite, cfg.DB.Driver)
	}
	if cfg.Env != EnvDevelopment {
		t.Errorf("默认环境应为 %q，实际 %q", EnvDevelopment, cfg.Env)
	}
	if cfg.DB.SQLitePath == "" {
		t.Error("SQLite 路径应有默认值")
	}
}

func TestLoadRejectsS3StorageInPhaseOne(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", strings.Repeat("a", 48))
	t.Setenv("WMIND_STORAGE_DRIVER", "s3")

	_, err := Load()
	if err == nil {
		t.Fatal("一期不支持 s3 存储，应当明确拒绝而不是静默降级")
	}
	if !strings.Contains(err.Error(), "WMIND_STORAGE_DRIVER") {
		t.Fatalf("错误信息应点名存储驱动变量，实际为: %v", err)
	}
}

// TestSummaryDoesNotLeakSecrets 守住一条安全底线：配置摘要会被写进启动日志，
// 一旦带上密钥，日志采集系统里就等于明文存了签名密钥与数据库密码。
func TestSummaryDoesNotLeakSecrets(t *testing.T) {
	const secret = "super-secret-jwt-signing-key-0123456789"
	const dbPassword = "postgres-password-should-not-appear"

	t.Setenv("WMIND_JWT_SECRET", secret)
	t.Setenv("WMIND_DB_DRIVER", "postgres")
	t.Setenv("WMIND_DATABASE_URL", "postgres://wmind:"+dbPassword+"@db:5432/wmind")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("配置加载失败: %v", err)
	}

	rendered := renderSummary(cfg.Summary())
	for _, forbidden := range []string{secret, dbPassword} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("配置摘要泄露了敏感值 %q: %s", forbidden, rendered)
		}
	}
}

func TestCORSOriginsSplitsAndTrims(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", strings.Repeat("a", 48))
	t.Setenv("WMIND_CORS_ORIGINS", "http://localhost:5173, http://127.0.0.1:5173 ,")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("配置加载失败: %v", err)
	}

	want := []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	if len(cfg.CORSOrigins) != len(want) {
		t.Fatalf("期望 %d 个来源，实际 %d 个: %#v", len(want), len(cfg.CORSOrigins), cfg.CORSOrigins)
	}
	for i := range want {
		if cfg.CORSOrigins[i] != want[i] {
			t.Errorf("第 %d 个来源: 期望 %q，实际 %q", i, want[i], cfg.CORSOrigins[i])
		}
	}
}

func renderSummary(kv []any) string {
	var b strings.Builder
	for _, v := range kv {
		b.WriteString(strings.TrimSpace(toStr(v)))
		b.WriteByte(' ')
	}
	return b.String()
}

func toStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if list, ok := v.([]string); ok {
		return strings.Join(list, ",")
	}
	return ""
}

func TestTwoFactorKeyConfiguration(t *testing.T) {
	t.Setenv("WMIND_JWT_SECRET", strings.Repeat("j", 48))
	t.Setenv("WMIND_2FA_ENCRYPTION_KEY", "short")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "WMIND_2FA_ENCRYPTION_KEY") {
		t.Fatalf("short key: %v", err)
	}
	key := strings.Repeat("m", 48)
	t.Setenv("WMIND_2FA_ENCRYPTION_KEY", key)
	cfg, err := Load()
	if err != nil || cfg.Auth.TwoFactorKey != key {
		t.Fatalf("key binding: %v", err)
	}
	if strings.Contains(renderSummary(cfg.Summary()), key) {
		t.Fatal("2FA key leaked in startup summary")
	}
}
