// Command desktop is wmind's desktop client entry point.
//
// 它把一个 mygo 窗口和一套本机后端进程装在一起：窗口里跑的是与 Web 完全
// 相同的前端，后端也是同一套 router（internal/bootstrap），数据落在本机
// SQLite。默认「本地模式」不需要任何账号，也完全不访问网络。
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/deskapi"
	"github.com/woliubang256/wmind/backend/desktop/internal/localmode"
	"github.com/woliubang256/wmind/backend/desktop/internal/localserver"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncengine"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
	"github.com/woliubang256/wmind/backend/internal/bootstrap"
)

// version 由构建时通过 -ldflags 注入（见 scripts/build-desktop.mjs），
// 未注入时退回 mygo 配置里的版本。
var version = ""

func main() {
	if err := run(); err != nil {
		log.Fatalf("wmind desktop: %v", err)
	}
}

func run() error {
	// 名字要在最前面定死：它决定用户数据目录与单实例锁的键。不设置的话，
	// `go run` 的临时二进制和打包出来的 .app 会拿到不同的名字，本地数据
	// 也就分裂在两个目录里。
	mygo.App.SetName("wmind")
	if version != "" {
		mygo.App.SetVersion(version)
	}

	// 单实例：第二次启动不再开窗口，由第一个实例处理（后续接入深链接与
	// 文件关联时，这里也是接收参数的地方）。
	if !mygo.App.RequestSingleInstanceLock() {
		return nil
	}

	mygo.App.WhenReady(func() {
		if err := start(); err != nil {
			log.Printf("wmind desktop: %v", err)
			mygo.App.Quit()
		}
	})
	return mygo.App.Run()
}

func start() error {
	userData, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return fmt.Errorf("resolve user data directory: %w", err)
	}
	paths, err := localmode.ResolvePaths(userData)
	if err != nil {
		return err
	}
	logger, closeLog, err := newLogger(paths.Root)
	if err != nil {
		return err
	}
	slog.SetDefault(logger)

	local, err := assembleLocal(context.Background(), paths, logger, appVersion())
	if err != nil {
		closeLog()
		return err
	}

	// start 会立刻返回，窗口关闭后才轮到 OnWillQuit：这里绝不能 defer 关闭，
	// 否则数据库在首屏请求到达之前就被关掉（表现为 /auth/me 500）。
	// 因此只在启动失败时清理。
	ok := false
	defer func() {
		if !ok {
			local.Close()
			closeLog()
		}
	}()

	ln, err := localserver.Listen()
	if err != nil {
		return fmt.Errorf("listen on loopback: %w", err)
	}
	srv := &http.Server{Handler: local.Handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("local server stopped", "err", err)
		}
	}()

	url := "http://" + ln.Addr().String() + "/"
	logger.Info("wmind desktop started", "url", url, "data", paths.Root)

	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		local.Close()
		closeLog()
	})

	// 隐藏系统标题栏但保留红绿灯（hiddenInset）：页面自己画顶栏，红绿灯叠在
	// 左上角。前端负责留出红绿灯区域并把顶栏声明为可拖拽（--app-region），
	// 见 frontend/src/app/layouts.tsx 与 styles.css 的 .wmind-desktop。
	mygo.NewWindow(mygo.WindowOptions{
		Title:         "wmind",
		URL:           url,
		Width:         1280,
		Height:        800,
		MinWidth:      1024,
		MinHeight:     640,
		TitleBarStyle: mygo.TitleBarHiddenInset,
	})
	ok = true
	return nil
}

// localInstance 是本地模式跑起来之后的一套东西。
type localInstance struct {
	// Handler 是内层 HTTP 服务：前端静态资源 + 后端 API + 桌面接口。
	Handler http.Handler
	// ShellToken 是桌面壳的访问令牌（页面 cookie）。
	ShellToken string
	// AccessToken 是注入页面的后端访问令牌。
	AccessToken string
	// Engine 是同步引擎（未连接云端时也能查状态）。
	Engine *syncengine.Engine
	// Close 停止后台任务并关闭数据库，可重复调用。
	Close func()
}

// assembleLocal 装配本地模式：本地库 → 后端 → 本地用户 → 令牌 → 内层服务。
//
// 抽成函数而不是留在 start 里，是为了让它能在测试里被完整跑一遍——这条链
// 上的任何一环断掉，桌面版就是一个打不开的窗口。
func assembleLocal(ctx context.Context, paths localmode.Paths, logger *slog.Logger, appVersion string) (*localInstance, error) {
	secrets, err := localmode.LoadSecrets(paths.Secrets)
	if err != nil {
		return nil, err
	}

	// 桌面端自己的表（map_sync / sync_meta）在迁移之后建：它们不属于服务端
	// schema，走 bootstrap 的 Prepare 钩子而不是迁移集。
	var syncStore *syncstate.Store
	app, err := bootstrap.New(ctx, localmode.Config(paths, secrets), bootstrap.Options{
		Logger: logger, Quiet: true,
		Prepare: func(ctx context.Context, db *sql.DB) error {
			if err := syncstate.Prepare(ctx, db); err != nil {
				return err
			}
			syncStore = syncstate.NewStore(db)
			return nil
		},
	})
	if err != nil {
		return nil, fmt.Errorf("start local backend: %w", err)
	}

	user, err := localmode.EnsureUser(ctx, app.Users, time.Now())
	if err != nil {
		app.Close()
		return nil, err
	}
	accessToken, err := localmode.Token(secrets.JWTSecret, user)
	if err != nil {
		app.Close()
		return nil, fmt.Errorf("issue local access token: %w", err)
	}

	shellToken, err := newToken()
	if err != nil {
		app.Close()
		return nil, err
	}

	engine := syncengine.New(app.Maps, syncStore, user.ID, logger)
	creds := &deskapi.CredentialStore{Path: filepath.Join(paths.Root, "cloud.json"), Secret: secrets.JWTSecret}

	// 上次连接过就试着接上：失败只记日志，不阻塞启动——离线优先。
	restoreCloud(ctx, engine, creds, logger)

	handler, err := localserver.New(localserver.Config{
		API:       app.Handler,
		Static:    frontendDist(),
		Token:     shellToken,
		Mode:      "local",
		Version:   appVersion,
		AuthToken: accessToken,
		Desktop:   deskapi.New(deskapi.Deps{Engine: engine, Store: syncStore, Creds: creds, Version: appVersion}),
	})
	if err != nil {
		app.Close()
		return nil, err
	}

	return &localInstance{
		Handler:     handler,
		ShellToken:  shellToken,
		AccessToken: accessToken,
		Engine:      engine,
		Close:       app.Close,
	}, nil
}

// restoreCloud 用上次保存的凭据恢复云端连接。
//
// 密码用本地主密钥解开再登录：刷新令牌虽然也存了，但桌面端长期离线，令牌
// 过期是常态，直接重登比处理「刷新失败再重登」简单且不会漏掉安全版本变化。
func restoreCloud(ctx context.Context, engine *syncengine.Engine, creds *deskapi.CredentialStore, logger *slog.Logger) {
	stored, err := creds.Load()
	if err != nil {
		logger.Warn("cloud: read saved connection failed", "err", err)
		return
	}
	if stored == nil {
		return
	}
	password, err := stored.Decrypt(creds.Secret)
	if err != nil {
		// 主密钥变了（用户删过 secrets.json）：凭据作废，让用户重新连接。
		logger.Warn("cloud: saved credentials cannot be decrypted", "err", err)
		return
	}
	client, err := cloud.Login(ctx, stored.ServerURL, stored.Identifier, password)
	if err != nil {
		logger.Info("cloud: reconnect skipped", "server", stored.ServerURL, "err", err)
		return
	}
	engine.Connect(client.Session().ServerURL, client)
	logger.Info("cloud: reconnected", "server", client.Session().ServerURL)
}

// appVersion 返回注入的版本，未注入时退回 mygo 配置里的版本。
func appVersion() string {
	if version != "" {
		return version
	}
	return mygo.App.Version()
}

// newToken 生成桌面壳的访问令牌：32 字节随机，仅存在于本次进程与页面 cookie。
func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// newLogger 把日志同时写到 stderr 与数据目录下的文件。
//
// 桌面端没有容器日志可看：用户报问题时能拿到文件才是关键。文件按启动
// 追加，不做轮转（单个文件，量级很小）。
func newLogger(root string) (*slog.Logger, func(), error) {
	logDir := filepath.Join(root, "logs")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return nil, nil, fmt.Errorf("create log directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(logDir, "wmind.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, nil, fmt.Errorf("open log file: %w", err)
	}
	w := io.MultiWriter(os.Stderr, file)
	logger := slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo}))
	return logger, func() { _ = file.Close() }, nil
}
