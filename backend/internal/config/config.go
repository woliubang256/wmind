// Package config 加载并校验应用配置。
//
// 配置来源优先级（低 → 高）：内置默认值 < .env 文件 < 进程环境变量。
// 环境变量名与 docs/07-部署与运维.md §4 的表格严格一致。
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/spf13/viper"
)

// 数据库驱动取值。
const (
	DriverSQLite   = "sqlite"
	DriverPostgres = "postgres"
)

// 运行环境取值。
const (
	EnvDevelopment = "development"
	EnvProduction  = "production"
)

// 存储驱动取值。s3 为二期预留。
const (
	StorageLocal = "local"
	StorageS3    = "s3"
)

// minJWTSecretLen 是 HS256 签名密钥的最小长度。
const minJWTSecretLen = 32

// envBindings 把配置键映射到环境变量名。
//
// 这里显式列出而不是靠「前缀 + 键名转大写」推导：有若干变量名与配置键的层级
// 并不对应（`WMIND_DATABASE_URL` 对应 `db.url`、`WMIND_JWT_SECRET` 对应
// `auth.jwt_secret`），推导会得到错误的名字。显式表也让「这个配置项从哪来」
// 一眼可查。
var envBindings = map[string]string{
	"env":             "WMIND_ENV",
	"addr":            "WMIND_ADDR",
	"log_level":       "WMIND_LOG_LEVEL",
	"auto_migrate":    "WMIND_AUTO_MIGRATE",
	"cors_origins":    "WMIND_CORS_ORIGINS",
	"trusted_proxies": "WMIND_TRUSTED_PROXIES",
	"upload_max_mb":   "WMIND_UPLOAD_MAX_MB",

	"db.driver":      "WMIND_DB_DRIVER",
	"db.sqlite_path": "WMIND_SQLITE_PATH",
	"db.url":         "WMIND_DATABASE_URL",
	"db.max_conns":   "WMIND_DB_MAX_CONNS",

	"auth.jwt_secret":  "WMIND_JWT_SECRET",
	"auth.access_ttl":  "WMIND_ACCESS_TOKEN_TTL",
	"auth.refresh_ttl": "WMIND_REFRESH_TOKEN_TTL",

	"storage.driver": "WMIND_STORAGE_DRIVER",
	"storage.dir":    "WMIND_STORAGE_DIR",

	"admin.email":    "WMIND_ADMIN_EMAIL",
	"admin.password": "WMIND_ADMIN_PASSWORD",
}

// Config 是应用的全部配置。
type Config struct {
	Env            string   `mapstructure:"env"`
	Addr           string   `mapstructure:"addr"`
	LogLevel       string   `mapstructure:"log_level"`
	AutoMigrate    bool     `mapstructure:"auto_migrate"`
	CORSOrigins    []string `mapstructure:"cors_origins"`
	TrustedProxies []string `mapstructure:"trusted_proxies"`
	UploadMaxMB    int      `mapstructure:"upload_max_mb"`

	DB      DB      `mapstructure:"db"`
	Auth    Auth    `mapstructure:"auth"`
	Storage Storage `mapstructure:"storage"`
	Admin   Admin   `mapstructure:"admin"`
}

// DB 是数据库连接配置。两种方言互斥，由 Driver 决定哪个字段生效。
type DB struct {
	Driver     string `mapstructure:"driver"`
	SQLitePath string `mapstructure:"sqlite_path"`
	URL        string `mapstructure:"url"`
	MaxConns   int    `mapstructure:"max_conns"`
}

// Auth 是认证配置。
type Auth struct {
	JWTSecret  string        `mapstructure:"jwt_secret"`
	AccessTTL  time.Duration `mapstructure:"access_ttl"`
	RefreshTTL time.Duration `mapstructure:"refresh_ttl"`
}

// Storage 是文件存储配置。
type Storage struct {
	Driver string `mapstructure:"driver"`
	Dir    string `mapstructure:"dir"`
}

// Admin 是首次启动时创建的管理员凭据（仅 users 表为空时生效）。
type Admin struct {
	Email    string `mapstructure:"email"`
	Password string `mapstructure:"password"`
}

// IsProduction 报告当前是否为生产环境。
func (c *Config) IsProduction() bool { return c.Env == EnvProduction }

// IsSQLite 报告当前数据库驱动是否为 SQLite。
//
// 只应在 cmd/server 的装配分叉里使用。service / handler 层禁止出现方言判断，
// 这条约束由 CI 的方言泄漏检查兜底。
func (c *Config) IsSQLite() bool { return c.DB.Driver == DriverSQLite }

// Load 读取配置。任何必填项缺失或非法都返回错误，调用方应直接退出。
func Load() (*Config, error) {
	loadDotEnv()

	v := viper.New()
	for key, env := range envBindings {
		if err := v.BindEnv(key, env); err != nil {
			return nil, fmt.Errorf("绑定环境变量 %s 失败: %w", env, err)
		}
	}
	setDefaults(v)

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}
	cfg.normalize()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// loadDotEnv 载入本地 .env，纯粹是开发便利。
//
// 文件缺失不是错误——生产环境由容器注入环境变量，不依赖 .env。
// godotenv.Load 不覆盖已存在的环境变量，因此真实环境变量始终优先。
func loadDotEnv() {
	for _, path := range []string{".env", "backend/.env"} {
		_ = godotenv.Load(path)
	}
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("env", EnvDevelopment)
	v.SetDefault("addr", ":8080")
	v.SetDefault("log_level", "info")
	v.SetDefault("auto_migrate", true)
	v.SetDefault("upload_max_mb", 10)

	v.SetDefault("db.driver", DriverSQLite)
	v.SetDefault("db.sqlite_path", "./data/wmind.db")
	v.SetDefault("db.max_conns", 20)

	v.SetDefault("auth.access_ttl", 15*time.Minute)
	v.SetDefault("auth.refresh_ttl", 168*time.Hour)

	v.SetDefault("storage.driver", StorageLocal)
	v.SetDefault("storage.dir", "./data/uploads")
}

func (c *Config) normalize() {
	c.Env = strings.ToLower(strings.TrimSpace(c.Env))
	c.LogLevel = strings.ToLower(strings.TrimSpace(c.LogLevel))
	c.DB.Driver = strings.ToLower(strings.TrimSpace(c.DB.Driver))
	c.Storage.Driver = strings.ToLower(strings.TrimSpace(c.Storage.Driver))
	c.CORSOrigins = trimList(c.CORSOrigins)
	c.TrustedProxies = trimList(c.TrustedProxies)
}

func (c *Config) validate() error {
	var problems []string

	if c.Env != EnvDevelopment && c.Env != EnvProduction {
		problems = append(problems, fmt.Sprintf(
			"WMIND_ENV 必须是 %q 或 %q，当前 %q", EnvDevelopment, EnvProduction, c.Env))
	}
	if !isValidLogLevel(c.LogLevel) {
		problems = append(problems, fmt.Sprintf(
			"WMIND_LOG_LEVEL 必须是 debug/info/warn/error 之一，当前 %q", c.LogLevel))
	}
	if len(c.Auth.JWTSecret) < minJWTSecretLen {
		problems = append(problems, fmt.Sprintf(
			"WMIND_JWT_SECRET 至少需要 %d 字节（当前 %d 字节）；生成：openssl rand -base64 48",
			minJWTSecretLen, len(c.Auth.JWTSecret)))
	}
	if c.Auth.AccessTTL <= 0 {
		problems = append(problems, "WMIND_ACCESS_TOKEN_TTL 必须为正数时长")
	}
	if c.Auth.RefreshTTL <= 0 {
		problems = append(problems, "WMIND_REFRESH_TOKEN_TTL 必须为正数时长")
	}

	switch c.DB.Driver {
	case DriverSQLite:
		if strings.TrimSpace(c.DB.SQLitePath) == "" {
			problems = append(problems, "WMIND_SQLITE_PATH 不能为空")
		}
	case DriverPostgres:
		if strings.TrimSpace(c.DB.URL) == "" {
			problems = append(problems, "使用 postgres 驱动时 WMIND_DATABASE_URL 必填")
		}
	default:
		problems = append(problems, fmt.Sprintf(
			"WMIND_DB_DRIVER 必须是 %q 或 %q，当前 %q", DriverSQLite, DriverPostgres, c.DB.Driver))
	}

	if c.Storage.Driver != StorageLocal {
		problems = append(problems, fmt.Sprintf(
			"WMIND_STORAGE_DRIVER 一期只支持 %q（%q 为二期），当前 %q",
			StorageLocal, StorageS3, c.Storage.Driver))
	}
	if strings.TrimSpace(c.Storage.Dir) == "" {
		problems = append(problems, "WMIND_STORAGE_DIR 不能为空")
	}
	if c.UploadMaxMB <= 0 {
		problems = append(problems, "WMIND_UPLOAD_MAX_MB 必须为正整数")
	}
	if c.DB.MaxConns <= 0 {
		problems = append(problems, "WMIND_DB_MAX_CONNS 必须为正整数")
	}

	if len(problems) > 0 {
		return fmt.Errorf("配置校验失败：\n  - %s", strings.Join(problems, "\n  - "))
	}
	return nil
}

// Summary 返回可安全写入日志的配置摘要。
//
// 绝不能直接把 Config 交给日志器——JWTSecret、数据库密码、初始管理员密码
// 都在里面。
func (c *Config) Summary() []any {
	return []any{
		"env", c.Env,
		"addr", c.Addr,
		"dbDriver", c.DB.Driver,
		"autoMigrate", c.AutoMigrate,
		"storageDriver", c.Storage.Driver,
		"corsOrigins", c.CORSOrigins,
	}
}

func isValidLogLevel(level string) bool {
	switch level {
	case "debug", "info", "warn", "error":
		return true
	default:
		return false
	}
}

func trimList(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
