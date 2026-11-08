package bootstrap

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/config"
)

// testConfig 是能真正装配起来的最小配置：SQLite 落在临时目录、存储目录
// 也临时，其余走默认值。它不经过 config.Load 的校验，因此这里必须自己
// 给出校验会强制要求的字段（JWT 密钥长度、存储目录）。
func testConfig(t *testing.T) *config.Config {
	t.Helper()
	dir := t.TempDir()
	return &config.Config{
		Env:         config.EnvDevelopment,
		Addr:        "127.0.0.1:0",
		LogLevel:    "error",
		AutoMigrate: true,
		DB: config.DB{
			Driver:     config.DriverSQLite,
			SQLitePath: filepath.Join(dir, "wmind.db"),
		},
		Auth: config.Auth{
			JWTSecret: "0123456789abcdef0123456789abcdef",
		},
		Storage: config.Storage{Dir: filepath.Join(dir, "uploads")},
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// 装配必须能真正跑起来：迁移、仓储、服务、路由、后台任务都要就位，
// 否则桌面端复用这套装配时会在启动阶段才炸。
func TestNewAssemblesWorkingRouter(t *testing.T) {
	app, err := New(context.Background(), testConfig(t), Options{Logger: testLogger()})
	if err != nil {
		t.Fatalf("装配失败: %v", err)
	}
	defer app.Close()

	if app.Handler == nil {
		t.Fatal("Handler 为空")
	}
	if len(app.Ready) != 1 || app.Ready[0].Name != "database" {
		t.Fatalf("就绪检查不符合预期: %+v", app.Ready)
	}
	if app.Auth == nil || app.Settings == nil || app.Backups == nil || app.AI == nil {
		t.Fatal("装配缺少服务实例")
	}

	rec := httptest.NewRecorder()
	app.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health/live", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("健康检查期望 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
}

// Close 会被 cmd/server 的 defer 调用，桌面端退出时也可能被调用两次
// （正常退出路径与错误路径）。重复调用必须安全，否则退出流程会 panic。
func TestCloseIsIdempotent(t *testing.T) {
	app, err := New(context.Background(), testConfig(t), Options{Logger: testLogger()})
	if err != nil {
		t.Fatalf("装配失败: %v", err)
	}
	app.Close()
	app.Close()
}

// 配置非法时不能返回半启动的实例：那会让调用方拿到可用 Handler 但后台
// 任务已经死掉的对象。
func TestNewRejectsInvalidConfig(t *testing.T) {
	cfg := testConfig(t)
	cfg.DB.Driver = "mysql"
	if _, err := New(context.Background(), cfg, Options{Logger: testLogger()}); err == nil {
		t.Fatal("未知方言应当报错")
	}

	if _, err := New(context.Background(), nil, Options{Logger: testLogger()}); err == nil {
		t.Fatal("缺少配置应当报错")
	}
	if _, err := New(context.Background(), testConfig(t), Options{}); err == nil {
		t.Fatal("缺少 logger 应当报错")
	}
}
