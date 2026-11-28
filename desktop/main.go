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
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo"
	// mygo 自己的界面文案（右键菜单、标准菜单项等）的中文目录：
	// 声明了 SetLanguages("zh-Hans", ...) 却不导入它，mygo 会在启动时警告
	// 「应用写的是 zh-Hans，但 MyGo 自己的字符串是英文」。
	_ "github.com/egoist/mygo/locales/zh-Hans"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/credstore"
	"github.com/woliubang256/wmind/backend/desktop/internal/deskapi"
	"github.com/woliubang256/wmind/backend/desktop/internal/localmode"
	"github.com/woliubang256/wmind/backend/desktop/internal/localserver"
	"github.com/woliubang256/wmind/backend/desktop/internal/logging"
	"github.com/woliubang256/wmind/backend/desktop/internal/mapsource"
	"github.com/woliubang256/wmind/backend/desktop/internal/mcpmode"
	"github.com/woliubang256/wmind/backend/desktop/internal/mcpserver"
	"github.com/woliubang256/wmind/backend/desktop/internal/openfiles"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncengine"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
	"github.com/woliubang256/wmind/backend/internal/bootstrap"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// version 由构建时通过 -ldflags 注入（见 scripts/build-desktop.mjs），
// 未注入时退回 mygo 配置里的版本。
var version = ""

func main() {
	// 子命令：`Wmind mcp-stdio` 是给 MCP 客户端用的 stdio 传输入口，不启动窗口。
	if len(os.Args) > 1 && os.Args[1] == "mcp-stdio" {
		// 兜底入口：真正的 stdio 客户端用同目录的 wmind_mcp（路径不带空格）。
		os.Exit(mcpmode.Run(appVersion()))
	}
	// 第一件事就写一行日志：如果应用在 WebView 初始化阶段就退出（Windows 上缺
	// WebView2 运行时的典型表现），这是唯一能留下的证据。
	earlyLog("process starting", map[string]string{
		"version": appVersion(), "os": runtime.GOOS, "arch": runtime.GOARCH,
	})
	if hint := webviewRuntimeHint(); hint != "" {
		earlyLog("webview runtime missing", map[string]string{"detail": hint})
		mygo.Dialog.Error("Wmind 无法启动", hint)
		os.Exit(1)
	}
	if err := run(); err != nil {
		// 打包后的应用没有控制台（Windows 上是 GUI 子系统），只写 stderr 等于
		// 「双击没反应、也没有任何提示」。这里同时落盘并弹一个原生对话框。
		reportStartupFailure(err)
		os.Exit(1)
	}
}

// earlyLog 在 mygo 就绪之前也能写日志。
//
// 不能依赖 mygo.App.Path：应用未就绪时它可能拿不到路径。这里按各平台的约定
// 拼出与正式日志相同的位置（macOS/Linux 用 os.UserConfigDir，Windows 是
// %APPDATA%），失败再退回临时目录——目的是「无论如何留下痕迹」。
func earlyLog(message string, fields map[string]string) {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	} else {
		dir = filepath.Join(dir, "Wmind", "logs")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		dir = os.TempDir()
	}
	path := filepath.Join(dir, "wmind.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	parts := make([]string, 0, len(fields))
	for key, value := range fields {
		parts = append(parts, key+"="+value)
	}
	exe, _ := os.Executable()
	_, _ = fmt.Fprintf(f, "[%s] %s %s exe=%s\n", time.Now().Format(time.RFC3339), message, strings.Join(parts, " "), exe)
}

// crashLogPath 返回启动失败日志的落盘位置。
//
// 先试应用数据目录（正常情况），失败再退回系统临时目录：数据目录本身创建
// 失败时（权限、磁盘满），至少还能在 %TEMP% / /tmp 里留下线索。
func crashLogPath() string {
	if dir, err := mygo.App.Path(mygo.PathUserData); err == nil && dir != "" {
		return filepath.Join(dir, "startup-error.log")
	}
	return filepath.Join(os.TempDir(), "wmind-startup-error.log")
}

// reportStartupFailure 把启动失败写进日志并弹窗告诉用户，附带日志路径。
func reportStartupFailure(err error) {
	message := fmt.Sprintf("%v\n\n时间：%s\n版本：%s\n系统：%s/%s", err,
		time.Now().Format(time.RFC3339), appVersion(), runtime.GOOS, runtime.GOARCH)
	path := crashLogPath()
	if writeErr := os.MkdirAll(filepath.Dir(path), 0o700); writeErr == nil {
		if f, openErr := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); openErr == nil {
			_, _ = fmt.Fprintf(f, "[%s] %s\n", time.Now().Format(time.RFC3339), message)
			_ = f.Close()
			message += "\n\n日志：" + path
		}
	}
	log.Printf("wmind desktop: %v", err)
	// 对话框失败也不能再抛：这时唯一能做的就是让用户看到日志路径。
	mygo.Dialog.Error("Wmind 启动失败", message)
}

func run() error {
	// 名字要在最前面定死：它决定用户数据目录与单实例锁的键。不设置的话，
	// `go run` 的临时二进制和打包出来的 .app 会拿到不同的名字，本地数据
	// 也就分裂在两个目录里。
	mygo.App.SetName("Wmind")
	// 声明应用的语言：mygo 会据此从系统偏好里挑出界面语言（中文系统给
	// zh-Hans），并通过 mygo:locale 事件告诉页面。不声明的话默认只有英文，
	// 中文系统的用户在桌面端会看到一整屏英文——这就是「画布没有国际化」
	// 的根因：不是画布没翻译，是 WebView 的 navigator.language 被钉成了 en。
	mygo.App.SetLanguages("zh-Hans", "en")
	if version != "" {
		mygo.App.SetVersion(version)
	}

	// 文件关联必须在单实例锁之前注册。mygo 会把第二个实例的参数转给第一个
	// 实例，然后在同一个 OnOpenFile 回调里派发；冷启动参数也走同一条路径。
	mygo.App.OnOpenFile(func(path string) {
		items := desktopOpenFiles.Add([]string{path})
		if len(items) == 0 {
			return
		}
		mygo.App.Focus()
		for _, item := range items {
			notifyOpenFile(item)
		}
	})
	mygo.App.OnSecondInstance(func(_ []string, _ string) { mygo.App.Focus() })

	// 单实例：第二次启动不再开窗口，由第一个实例处理（后续接入深链接与
	// 文件关联时，这里也是接收参数的地方）。
	if !mygo.App.RequestSingleInstanceLock() {
		// 正常情况：已有实例在跑，第二次启动不该开新窗口。但如果上一个实例
		// 启动失败却还活着（窗口没建成），用户点图标就会「什么都没发生」——
		// 这里至少留下一条记录，配合 startup-error.log 能看出是不是这个原因。
		if dir, err := mygo.App.Path(mygo.PathUserData); err == nil {
			if f, openErr := os.OpenFile(filepath.Join(dir, "startup-error.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); openErr == nil {
				_, _ = fmt.Fprintf(f, "[%s] 已有实例持有单实例锁，本次启动退出（若看不到窗口，请结束残留的 Wmind 进程后重试）\n",
					time.Now().Format(time.RFC3339))
				_ = f.Close()
			}
		}
		return nil
	}

	mygo.App.WhenReady(func() {
		if err := start(); err != nil {
			// 只 log + Quit 的话：Windows 上没有控制台看不到，而且 Quit 若没
			// 生效，进程会带着单实例锁活着——用户再点图标就「什么都没发生」。
			reportStartupFailure(err)
			mygo.App.Quit()
			os.Exit(1)
		}
	})
	return mygo.App.Run()
}

func start() error {
	userData, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return fmt.Errorf("resolve user data directory: %w", err)
	}
	// WMIND_DESKTOP_DATA_DIR 覆盖数据目录：本地冒烟/截图测试用它指向临时目录，
	// 免得像之前那样 `rm -rf` 真实目录把用户数据（含登录信息）一起清掉。
	if override := strings.TrimSpace(os.Getenv("WMIND_DESKTOP_DATA_DIR")); override != "" {
		userData = override
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
	logger.Info("wmind desktop starting",
		"version", appVersion(), "os", runtime.GOOS, "arch", runtime.GOARCH,
		"data", paths.Root, "locale", mygo.App.Locale())

	local, err := assembleLocal(context.Background(), paths, logger, appVersion(), localeInfo{
		Locale:    mygo.App.Locale(),
		Preferred: mygo.App.PreferredLanguages(),
	})
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

	// WMIND_DESKTOP_ROUTE 让窗口直接打开某个前端路由（如 /maps/<uid>），
	// 只用于本地冒烟与截图核对，正常启动不设它就进首页。
	route := strings.TrimSpace(os.Getenv("WMIND_DESKTOP_ROUTE"))
	url := "http://" + ln.Addr().String() + "/" + strings.TrimPrefix(route, "/")
	logger.Info("wmind desktop started", "url", url, "data", paths.Root)

	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		local.MCP.Stop()
		local.Close()
		closeLog()
	})

	// 隐藏系统标题栏但保留红绿灯（hiddenInset）：页面自己画顶栏，红绿灯叠在
	// 左上角。前端负责留出红绿灯区域并把顶栏声明为可拖拽（--app-region），
	// 见 frontend/src/app/layouts.tsx 与 styles.css 的 .wmind-desktop。
	window := mygo.NewWindow(mygo.WindowOptions{
		Title:         "Wmind",
		URL:           url,
		Width:         1280,
		Height:        800,
		MinWidth:      1024,
		MinHeight:     640,
		TitleBarStyle: mygo.TitleBarHiddenInset,
	})
	if window == nil {
		return fmt.Errorf("创建窗口失败：WebView 初始化未成功（Windows 需要 WebView2 运行时）")
	}
	evalWindow = window
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
	// MCP 是本地 MCP 服务（AI 客户端读写本机导图），退出时要停。
	MCP *mcpserver.Manager
	// Close 停止后台任务并关闭数据库，可重复调用。
	Close func()
}

// assembleLocal 装配本地模式：本地库 → 后端 → 本地用户 → 令牌 → 内层服务。
//
// 抽成函数而不是留在 start 里，是为了让它能在测试里被完整跑一遍——这条链
// 上的任何一环断掉，桌面版就是一个打不开的窗口。
// localeInfo 是注入页面的语言信息。
//
// 从 start() 传进来而不是在 assembleLocal 里直接问 mygo：mygo.App.Locale()
// 会等待应用就绪，而测试里根本没有 mygo 应用，调它会把测试挂死。
type localeInfo struct {
	Locale    string
	Preferred []string
}

func assembleLocal(ctx context.Context, paths localmode.Paths, logger *slog.Logger, appVersion string, locale localeInfo) (*localInstance, error) {
	secrets, err := localmode.LoadSecrets(paths.Secrets)
	if err != nil {
		return nil, err
	}

	// 桌面端自己的表（map_sync / sync_meta）在迁移之后建：它们不属于服务端
	// schema，走 bootstrap 的 Prepare 钩子而不是迁移集。
	var syncStore *syncstate.Store
	var sourceStore *mapsource.Store
	var localDB *sql.DB
	app, err := bootstrap.New(ctx, localmode.Config(paths, secrets), bootstrap.Options{
		Logger: logger, Quiet: true,
		Prepare: func(ctx context.Context, db *sql.DB) error {
			if err := syncstate.Prepare(ctx, db); err != nil {
				return err
			}
			if err := mapsource.Prepare(ctx, db); err != nil {
				return err
			}
			if err := credstore.Prepare(ctx, db); err != nil {
				return err
			}
			syncStore = syncstate.NewStore(db)
			sourceStore = mapsource.NewStore(db)
			localDB = db
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
	// 媒体会话：/uploads 的鉴权只认 refresh token 派生的媒体令牌，而本地模式
	// 没有登录。这里替本机用户签发一次会话，把派生的媒体令牌下发成 cookie。
	mediaToken := ""
	if session, err := app.Auth.IssueLocalSession(ctx, user, service.SessionMeta{Platform: "desktop"}); err != nil {
		logger.Warn("local media session failed; thumbnails and images will not load", "err", err)
	} else if token, err := app.Auth.MediaToken(session); err != nil {
		logger.Warn("local media token failed; thumbnails and images will not load", "err", err)
	} else {
		mediaToken = token
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

	engine := syncengine.New(app.Maps, syncStore, user.ID, logger, &syncengine.LocalImages{
		Files: app.Files, Dir: paths.Uploads, Gate: app.Backups.Gate(),
	})
	// 本地 MCP：与登录状态无关，数据在本机。启动时按设置决定是否监听。
	mcpManager := mcpserver.New(app.MapService, user.ID, appVersion, logger)
	if snapshot := app.Settings.Snapshot(); snapshot.Bool("mcp.enabled") {
		if err := mcpManager.Apply(ctx, true, snapshot.Int("mcp.port"), snapshot.String("mcp.token")); err != nil {
			logger.Warn("local mcp server failed to start", "err", err)
		}
	}
	// 凭据存本地数据库（不用系统钥匙串：见 internal/credstore 的说明）。
	creds := &deskapi.CredentialStore{Repo: credstore.New(localDB, secrets.JWTSecret)}

	// Restore a refresh-only session without requiring startup networking.
	restoreCloud(engine, creds, logger)

	// 更新检查走 mygo 的签名更新源（GitHub releases，标签前缀 desktop-v）。
	// 开发构建里 Enabled() 为 false，接口会明确返回「不支持」，界面据此隐藏入口。
	updates := newUpdaterAdapter()

	handler, err := localserver.New(localserver.Config{
		API:                app.Handler,
		Static:             frontendDist(),
		Token:              shellToken,
		Mode:               "local",
		Version:            appVersion,
		AuthToken:          accessToken,
		MediaToken:         mediaToken,
		Locale:             locale.Locale,
		PreferredLanguages: locale.Preferred,
		Desktop: deskapi.New(deskapi.Deps{
			Engine: engine, Store: syncStore, Creds: creds, Version: appVersion, Updater: updates,
			OpenFiles: desktopOpenFiles, Sources: sourceStore,
			OpenExternal:       mygo.Shell.OpenExternal,
			RevealInFolder:     func(path string) error { mygo.Shell.ShowItemInFolder(path); return nil },
			Logger:             logger,
			Settings:           app.Settings,
			MCP:                mcpManager,
			LastConnectionPath: filepath.Join(paths.Root, "last-connection.json"),
			Eval:               debugEval,
		}),
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
		MCP:         mcpManager,
		Close:       app.Close,
	}, nil
}

// evalWindow 是主窗口，调试构建里用来在页面中执行 JS 量性能。
var evalWindow *mygo.Window

// desktopOpenFiles 在整个进程生命周期内保存系统交给应用的文件。
//
// 它必须在 RequestSingleInstanceLock 之前就存在并注册监听器：第一次启动的
// argv、第二个实例转发的 argv、Dock/资源管理器打开与拖放，mygo 最终都统一
// 通过 App.OnOpenFile 派发。
var desktopOpenFiles = openfiles.New()

// notifyOpenFile 敲一下当前页面；可靠性由 GET /desktop/open-files 兜底，因而
// 页面尚未创建、正在导航或已经关闭时，事件失败也不会丢文件。
func notifyOpenFile(file openfiles.File) {
	window := evalWindow
	if window == nil {
		return
	}
	payload, err := json.Marshal(file)
	if err != nil {
		return
	}
	go func() {
		code := fmt.Sprintf(`window.dispatchEvent(new CustomEvent("wmind:open-file", {detail:%s}));`, payload)
		_, _ = window.Page().Eval(code)
	}()
}

// debugEval 在页面里执行 JS，仅当 WMIND_DEBUG_EVAL=1 时可用。
//
// 用来在**真实 WebView** 里量性能（弹层打开耗时、节点数、字体状态等）：
// 浏览器和 WKWebView 的差异光看代码看不出来，得拿到页面里的数字。
func debugEval(code string) (any, error) {
	if os.Getenv("WMIND_DEBUG_EVAL") != "1" {
		return nil, fmt.Errorf("debug eval is disabled")
	}
	if evalWindow == nil {
		return nil, fmt.Errorf("window is not ready")
	}
	return evalWindow.Page().Eval(code)
}

// restoreCloud restores only the refresh credential. The first remote request
// renews it, so offline startup preserves the account and does not block the UI.
func restoreCloud(engine *syncengine.Engine, creds *deskapi.CredentialStore, logger *slog.Logger) {
	stored, err := creds.Load()
	if err != nil {
		logger.Warn("cloud: read saved connection failed", "err", err)
		return
	}
	if stored == nil {
		return
	}
	if stored.RefreshToken == "" {
		// Rewrite legacy records to discard the stored account password, while
		// keeping address/identifier metadata for the next interactive login.
		if err := creds.Save(*stored); err != nil {
			logger.Warn("cloud: migrate saved connection failed", "err", err)
		}
		logger.Info("cloud: saved connection requires sign-in")
		return
	}
	client, err := cloud.New(stored.ServerURL, cloud.Session{
		RefreshToken: stored.RefreshToken, RefreshExpiresAt: stored.RefreshExpiresAt,
		UserUID: stored.UserUID, UserEmail: stored.Email, Role: stored.Role, Nickname: stored.Nickname,
	})
	if err != nil {
		logger.Warn("cloud: saved server address is invalid", "err", err)
		return
	}
	if err := creds.Attach(client, stored.Identifier); err != nil {
		logger.Warn("cloud: restore saved session failed", "err", err)
		return
	}
	engine.Connect(client.Session().ServerURL, client)
	logger.Info("cloud: saved session restored", "server", client.Session().ServerURL)
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
	// 滚动日志：单文件 5 MiB、保留 5 份（见 internal/logging）。级别可用
	// WMIND_DESKTOP_LOG_LEVEL=debug 临时调细，排查时不用改代码。
	logger, closeLog, err := logging.New(logging.Options{
		Root:   root,
		Level:  os.Getenv("WMIND_DESKTOP_LOG_LEVEL"),
		Stderr: true,
	})
	if err != nil {
		// 文件写不了（Windows 上被杀软占用、磁盘满）时仍然继续启动，只记一条警告。
		logger.Warn("log file unavailable, logging to stderr only", "err", err)
	}
	return logger, closeLog, nil
}
