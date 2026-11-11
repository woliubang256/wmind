// Package deskapi 提供桌面端专有的 HTTP 接口，挂在 /desktop/ 下。
//
// 它们不属于 Web API：前端只在桌面壳里调用，用来连接云端、触发同步、上传
// 单张导图、查询本地/云端来源。全部由 localserver 的壳令牌 cookie 守着
// （同源、HttpOnly），因此这里不再单独鉴权。
package deskapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/cloudcreds"
	"github.com/woliubang256/wmind/backend/desktop/internal/remoteproxy"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncengine"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// lastConnection 记住上次登录过的服务器与账号，**登出后不清**：下次登录时
// 预填，省得用户重敲地址。只存这两项，不含任何凭据。
type lastConnection struct {
	ServerURL  string `json:"serverUrl"`
	Identifier string `json:"identifier"`
}

// saveLastConnection 记住上次登录过的服务器与账号（非机密，登出后不清）。
func (a *api) saveLastConnection(serverURL, identifier string) {
	if a.deps.LastConnectionPath == "" || serverURL == "" {
		return
	}
	raw, err := json.Marshal(lastConnection{ServerURL: serverURL, Identifier: identifier})
	if err != nil {
		return
	}
	if err := os.WriteFile(a.deps.LastConnectionPath, raw, 0o600); err != nil && a.deps.Logger != nil {
		a.deps.Logger.Warn("cloud: save last connection failed", "err", err)
	}
}

// loadLastConnection 读取上次连接信息；没有时返回零值。
func (a *api) loadLastConnection() lastConnection {
	if a.deps.LastConnectionPath == "" {
		return lastConnection{}
	}
	raw, err := os.ReadFile(a.deps.LastConnectionPath)
	if err != nil {
		return lastConnection{}
	}
	var last lastConnection
	if err := json.Unmarshal(raw, &last); err != nil {
		return lastConnection{}
	}
	return last
}

// 关于页用到的固定链接。
//
// 刻意不接受前端传 URL：`Shell.OpenExternal` 能打开任意 scheme，一旦可以传参
// 就等于把「打开浏览器」做成开放跳转。这里只暴露两个写死的地址。
const (
	projectURL = "https://github.com/woliubang256/wmind"
	docsURL    = "https://github.com/woliubang256/wmind/blob/main/docs/07-%E9%83%A8%E7%BD%B2%E4%B8%8E%E8%BF%90%E7%BB%B4.md"
)

// CredentialStore 读写云端连接凭据。
//
// 凭据存在**本地数据库**里（desktop_secrets 表，密码 AES-GCM 加密），不用系统
// 钥匙串：自构建应用每次更新签名都会变，钥匙串会把它当成另一个应用，于是每次
// 升级都要重新授权、甚至重新登录。凭据本就是「本机这份数据」的一部分，跟着数据
// 目录走更符合预期。
type CredentialStore struct {
	Repo CredentialRepo
}

// CredentialRepo 是凭据存储的实现（见 internal/credstore）。
type CredentialRepo interface {
	Load() (*cloudcreds.Credentials, error)
	Save(creds cloudcreds.Credentials, password string) error
	Clear() error
}

// Load 读取凭据；没有连接时返回 nil。
func (c *CredentialStore) Load() (*cloudcreds.Credentials, error) { return c.Repo.Load() }

// Save 保存凭据。
func (c *CredentialStore) Save(creds cloudcreds.Credentials, password string) error {
	return c.Repo.Save(creds, password)
}

// Clear 删除凭据。
func (c *CredentialStore) Clear() error { return c.Repo.Clear() }

// UpdateInfo 是检查更新的结果。
type UpdateInfo struct {
	Version string
	Notes   string
	Date    string
}

// UpdateProgress 是下载/安装进度。
type UpdateProgress struct {
	Phase      string
	Downloaded int64
	Total      int64
	Error      string
}

// Updater 是自我更新能力（由桌面入口用 mygo 的更新器实现）。
//
// 定义成接口是为了能测：真实的实现要发网络请求、要替换应用本体，测试里
// 用假实现覆盖「检查 → 安装 → 进度 → 重启」这条链。
type Updater interface {
	Enabled() bool
	Check(ctx context.Context) (*UpdateInfo, error)
	StartInstall(ctx context.Context) error
	Progress() UpdateProgress
	Relaunch()
}

// Deps 是接口需要的依赖。
type Deps struct {
	Engine  *syncengine.Engine
	Store   *syncstate.Store
	Creds   *CredentialStore
	Version string
	// Login 覆盖登录实现，测试用；为空时用 cloud.Login。
	Login func(ctx context.Context, serverURL, identifier, password string) (*cloud.Client, error)
	// Updater 是自我更新能力；为空时不挂载更新接口。
	Updater Updater
	// OpenExternal 用系统默认浏览器打开 URL；为空时用默认实现（测试替换）。
	OpenExternal func(url string) error
	// Logger 记录非致命的降级（比如拉不到远端资料）。
	Logger *slog.Logger
	// LastConnectionPath 是「上次登录的服务器与账号」的文件路径（非机密）。
	LastConnectionPath string
	// Eval 在页面里执行一段 JS 并返回结果；只在调试构建里接上（见 main.go 的
	// WMIND_DEBUG_EVAL）。用于在真实 WebView 里量性能，别在生产里开放。
	Eval func(code string) (any, error)
	// Settings 是本地站点设置：MCP 的开关、端口与令牌都存在这里。
	Settings SettingsStore
	// MCP 管理本地 MCP 服务的启停。
	MCP MCPManager
}

// New 构造 /desktop/ 的 Handler。
func New(deps Deps) http.Handler {
	if deps.OpenExternal == nil {
		deps.OpenExternal = func(string) error { return errors.New("deskapi: OpenExternal is not configured") }
	}
	a := &api{deps: deps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /desktop/status", a.status)
	mux.HandleFunc("POST /desktop/cloud/connect", a.connect)
	mux.HandleFunc("POST /desktop/cloud/disconnect", a.disconnect)
	if deps.Eval != nil {
		mux.HandleFunc("POST /desktop/debug/eval", a.evalJS)
	}
	mux.HandleFunc("/desktop/mcp", a.mcp)
	mux.Handle(remoteproxy.Prefix, a.remoteHandler())
	mux.Handle(remoteproxy.UploadsPrefix, a.remoteUploadsHandler())
	mux.HandleFunc("POST /desktop/about/open-project", a.openProject)
	mux.HandleFunc("POST /desktop/about/open-docs", a.openDocs)
	mux.HandleFunc("POST /desktop/cloud/verify-2fa", a.verifyTwoFactor)
	mux.HandleFunc("POST /desktop/sync", a.sync)
	mux.HandleFunc("GET /desktop/maps/sources", a.sources)
	mux.HandleFunc("POST /desktop/maps/{uid}/upload", a.upload)
	mux.HandleFunc("POST /desktop/maps/{uid}/resolve", a.resolve)
	mux.HandleFunc("POST /desktop/maps/{uid}/touch", a.touch)
	if deps.Updater != nil {
		mux.HandleFunc("GET /desktop/updates/check", a.checkUpdates)
		mux.HandleFunc("POST /desktop/updates/install", a.installUpdate)
		mux.HandleFunc("GET /desktop/updates/progress", a.updateProgress)
		mux.HandleFunc("POST /desktop/updates/relaunch", a.relaunch)
	}
	return a.withAccessLog(mux)
}

// withAccessLog 记录 /desktop/* 的每次调用。
//
// 这些接口是「客户端行为」的唯一入口：登录、同步、上传、更新都在这里。用户
// 反馈「点了没反应」时，日志里有没有这一行、返回什么状态码，决定了下一步往
// 哪里查——之前这里完全静默，等于把排查的起点丢了。
func (a *api) withAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.deps.Logger == nil {
			next.ServeHTTP(w, r)
			return
		}
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		elapsed := time.Since(started)
		attrs := []any{
			"method", r.Method, "path", r.URL.Path,
			"status", recorder.status, "durationMs", elapsed.Milliseconds(),
		}
		if recorder.body.Len() > 0 {
			attrs = append(attrs, "error", recorder.body.String())
		}
		if recorder.status >= 400 {
			a.deps.Logger.Warn("desktop api", attrs...)
			return
		}
		a.deps.Logger.Debug("desktop api", attrs...)
	})
}

// statusRecorder 记下状态码与错误响应体（只留前 512 字节，避免把大响应写进日志）。
type statusRecorder struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(p []byte) (int, error) {
	if r.status >= 400 && r.body.Len() < 512 {
		remaining := 512 - r.body.Len()
		if len(p) < remaining {
			remaining = len(p)
		}
		r.body.Write(p[:remaining])
	}
	return r.ResponseWriter.Write(p)
}

type api struct {
	deps Deps
	// pending 是等待两步验证码的登录（内存里，5 分钟后作废）。
	mu      sync.Mutex
	pending *pendingTwoFactor
}

type pendingTwoFactor struct {
	client     *cloud.Client
	password   string
	identifier string
	expires    time.Time
}

type envelope struct {
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, body envelope) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, envelope{Error: message})
}

func (a *api) login(ctx context.Context, serverURL, identifier, password string) (*cloud.Client, error) {
	if a.deps.Login != nil {
		return a.deps.Login(ctx, serverURL, identifier, password)
	}
	return cloud.Login(ctx, serverURL, identifier, password)
}

// ── 状态 ────────────────────────────────────────────────────────────────────

type cloudStatus struct {
	Connected bool   `json:"connected"`
	ServerURL string `json:"serverUrl,omitempty"`
	Email     string `json:"email,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
	// LastServerURL / LastIdentifier 是上次登录过的服务器与账号，登出后仍在，
	// 供登录表单预填。
	LastServerURL  string `json:"lastServerUrl,omitempty"`
	LastIdentifier string `json:"lastIdentifier,omitempty"`
	Role           string `json:"role,omitempty"`
	LastSyncedAt   string `json:"lastSyncedAt,omitempty"`
}

type statusResponse struct {
	Mode     string      `json:"mode"`
	Version  string      `json:"version"`
	Cloud    cloudStatus `json:"cloud"`
	Local    int         `json:"localMaps"`
	Synced   int         `json:"syncedMaps"`
	Pending  int         `json:"pendingMaps"`
	Conflict []string    `json:"conflictMaps"`
}

func (a *api) status(w http.ResponseWriter, r *http.Request) {
	records, err := a.deps.Store.List(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, "读取同步状态失败")
		return
	}
	resp := statusResponse{Mode: "local", Version: a.deps.Version, Conflict: []string{}}
	resp.Cloud.Connected = a.deps.Engine.Connected()
	resp.Cloud.ServerURL = a.deps.Engine.ServerURL()

	last := a.loadLastConnection()
	resp.Cloud.LastServerURL = last.ServerURL
	resp.Cloud.LastIdentifier = last.Identifier
	if creds, err := a.deps.Creds.Load(); err == nil && creds != nil {
		resp.Cloud.Email = creds.Email
		resp.Cloud.Role = creds.Role
		resp.Cloud.Nickname = creds.Nickname
		if resp.Cloud.ServerURL == "" {
			resp.Cloud.ServerURL = creds.ServerURL
		}
	}

	var newest time.Time
	for _, rec := range records {
		switch rec.State {
		case syncstate.StateSynced:
			resp.Synced++
		case syncstate.StateConflict:
			resp.Conflict = append(resp.Conflict, rec.MapUID)
		default:
			resp.Pending++
		}
		if rec.LastSyncedAt != nil && rec.LastSyncedAt.After(newest) {
			newest = *rec.LastSyncedAt
		}
	}
	resp.Local = len(records)
	if !newest.IsZero() {
		resp.Cloud.LastSyncedAt = newest.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, envelope{Data: resp})
}

// ── 连接 ────────────────────────────────────────────────────────────────────

type connectRequest struct {
	ServerURL  string `json:"serverUrl"`
	Identifier string `json:"identifier"`
	Password   string `json:"password"`
}

func (a *api) connect(w http.ResponseWriter, r *http.Request) {
	var req connectRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	if strings.TrimSpace(req.ServerURL) == "" || strings.TrimSpace(req.Identifier) == "" || req.Password == "" {
		fail(w, http.StatusUnprocessableEntity, "请填写服务器地址、账号与密码")
		return
	}

	a.log().Info("cloud: connecting", "server", req.ServerURL, "identifier", req.Identifier)
	client, err := a.login(r.Context(), req.ServerURL, req.Identifier, req.Password)
	if err != nil {
		a.log().Warn("cloud: connect failed", "server", req.ServerURL, "err", err)
		switch {
		case errors.Is(err, cloud.ErrUnauthorized):
			fail(w, http.StatusUnauthorized, "账号或密码不正确")
		case errors.Is(err, cloud.ErrUnavailable):
			// 带上底层原因（TLS 证书、DNS、超时、被防火墙拦），否则用户只看到
			// 「连接失败」，我们这边也无从判断。
			fail(w, http.StatusBadGateway, "连接服务器失败："+errorText(err))
		default:
			fail(w, http.StatusBadGateway, "登录失败："+errorText(err))
		}
		return
	}

	// 拉一次远端资料：顶栏要显示登录后的昵称。失败不致命，退回邮箱。
	a.logProfileError(client.Me(r.Context()))

	session := client.Session()
	// 账号开了两步验证：服务端只给了挑战令牌。把这次登录挂在内存里，
	// 等前端提交动态码后再完成（密码不用再传一遍，也不会留在前端）。
	if session.TwoFactorChallenge != "" {
		a.pending = &pendingTwoFactor{
			client: client, password: req.Password, identifier: req.Identifier,
			expires: time.Now().Add(5 * time.Minute),
		}
		writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
			"twoFactorRequired": true,
			"serverUrl":         session.ServerURL,
		}})
		return
	}

	a.deps.Engine.Connect(session.ServerURL, client)
	a.saveLastConnection(session.ServerURL, req.Identifier)
	if err := a.deps.Creds.Save(cloudcreds.Credentials{
		ServerURL: session.ServerURL, Identifier: req.Identifier,
		Email: session.UserEmail, UserUID: session.UserUID, Role: session.Role,
		Nickname:     session.Nickname,
		RefreshToken: session.RefreshToken,
	}, req.Password); err != nil {
		fail(w, http.StatusInternalServerError, "保存连接信息失败")
		return
	}

	a.log().Info("cloud: connected", "server", session.ServerURL, "email", session.UserEmail, "role", session.Role)

	// 这里**不做同步**：首次同步要拉全部导图，几秒到几十秒，放在登录响应里
	// 会让「登录」按钮一直转（两步验证时尤其明显）。前端登录成功后再异步
	// 触发 /desktop/sync，失败也不影响已建立的连接。
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
		"serverUrl": session.ServerURL,
		"email":     session.UserEmail,
		"nickname":  session.Nickname,
	}})
}

// log 返回日志器；测试里没注入时用一个丢弃的实例。
func (a *api) log() *slog.Logger {
	if a.deps.Logger != nil {
		return a.deps.Logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (a *api) disconnect(w http.ResponseWriter, r *http.Request) {
	a.deps.Engine.Disconnect()
	if err := a.deps.Creds.Clear(); err != nil {
		fail(w, http.StatusInternalServerError, "清除连接信息失败")
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"connected": false}})
}

// evalJS 在页面里执行一段 JS（仅调试构建）。响应是 {"data": {"result": ...}}。
func (a *api) evalJS(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	result, err := a.deps.Eval(req.Code)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"result": result}})
}

// remoteHandler 把 /desktop/remote-api/* 转发到云端同名接口。
//
// 每次都按**当前**客户端现建转发器：登录、退出、重连都会换一个客户端实例，
// 缓存下来的处理器会一直拿着旧令牌，表现为「明明登录了却提示要登录」。
func (a *api) remoteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		client := a.deps.Engine.Client()
		if client == nil {
			fail(w, http.StatusConflict, "尚未连接云端")
			return
		}
		handler, err := remoteproxy.Handler(client, a.deps.Engine.ServerURL(),
			remoteproxy.Prefix, "/api/v1", a.deps.Logger)
		if err != nil {
			fail(w, http.StatusBadGateway, "服务器地址无效")
			return
		}
		handler.ServeHTTP(w, r)
	})
}

// remoteUploadsHandler 把 /desktop/remote-uploads/* 转发到远端的 /uploads/*。
//
// 云端导图的缩略图、图片都挂在远端上传目录下；桌面端把它们当作同源地址直接
// 显示，离线时自然退化成占位图。
func (a *api) remoteUploadsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		client := a.deps.Engine.Client()
		if client == nil {
			http.NotFound(w, r)
			return
		}
		handler, err := remoteproxy.Handler(client, a.deps.Engine.ServerURL(),
			remoteproxy.UploadsPrefix, "/uploads", a.deps.Logger)
		if err != nil {
			http.Error(w, "服务器地址无效", http.StatusBadGateway)
			return
		}
		handler.ServeHTTP(w, r)
	})
}

// SettingsStore 是设置服务的只读+更新接口（见 backend/internal/settings）。
type SettingsStore interface {
	Snapshot() *settings.Snapshot
	Update(ctx context.Context, patch map[string]any, actorID *int64) (*settings.Snapshot, error)
}

// MCPManager 管理本地 MCP 服务。
type MCPManager interface {
	Apply(ctx context.Context, enabled bool, port int, token string) error
	URL() string
}

// mcpStatus 是 GET /desktop/mcp 的返回。
type mcpStatus struct {
	Enabled   bool   `json:"enabled"`
	Transport string `json:"transport"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	URL       string `json:"url,omitempty"`
	// Command / Args 是 stdio 客户端要填的启动命令（当前可执行文件 + mcp-stdio）。
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

// mcp 处理 GET/PUT /desktop/mcp。
//
// 本地 MCP 与登录状态无关：数据在本机，AI 操作的就是本机这一份。开关、端口
// 与令牌存在本地站点设置里，改完立即重启监听。
func (a *api) mcp(w http.ResponseWriter, r *http.Request) {
	if a.deps.Settings == nil || a.deps.MCP == nil {
		fail(w, http.StatusNotImplemented, "当前构建不支持 MCP")
		return
	}
	switch r.Method {
	case http.MethodGet:
		snapshot := a.deps.Settings.Snapshot()
		writeJSON(w, http.StatusOK, envelope{Data: a.mcpStatusOf(snapshot)})
	case http.MethodPut:
		var req struct {
			Enabled    *bool  `json:"enabled"`
			Transport  string `json:"transport"`
			Port       *int   `json:"port"`
			Regenerate bool   `json:"regenerate"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
			fail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
		snapshot := a.deps.Settings.Snapshot()
		patch := map[string]any{}
		if req.Enabled != nil {
			patch["mcp.enabled"] = *req.Enabled
		}
		if req.Transport != "" {
			patch["mcp.transport"] = req.Transport
		}
		if req.Port != nil {
			patch["mcp.port"] = *req.Port
		}
		token := snapshot.String("mcp.token")
		if req.Regenerate || token == "" {
			generated, err := newMCPToken()
			if err != nil {
				fail(w, http.StatusInternalServerError, "生成密钥失败")
				return
			}
			token = generated
			patch["mcp.token"] = token
		}
		updated, err := a.deps.Settings.Update(r.Context(), patch, nil)
		if err != nil {
			fail(w, http.StatusUnprocessableEntity, errorText(err))
			return
		}
		enabled := updated.Bool("mcp.enabled")
		port := updated.Int("mcp.port")
		// 只有 http 传输才需要常驻监听；stdio 由客户端按需拉起子进程。
		listen := enabled && updated.String("mcp.transport") == "http"
		if err := a.deps.MCP.Apply(r.Context(), listen, port, updated.String("mcp.token")); err != nil {
			// 端口被占用之类：把开关关回去，避免界面显示「已开启」但实际没起。
			_, _ = a.deps.Settings.Update(r.Context(), map[string]any{"mcp.enabled": false}, nil)
			fail(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, envelope{Data: a.mcpStatusOf(updated)})
	default:
		w.Header().Set("Allow", "GET, PUT")
		fail(w, http.StatusMethodNotAllowed, "不支持的方法")
	}
}

// mcpStatusOf 组装状态响应。
func (a *api) mcpStatusOf(snapshot *settings.Snapshot) mcpStatus {
	exe, _ := os.Executable()
	return mcpStatus{
		Enabled:   snapshot.Bool("mcp.enabled"),
		Transport: snapshot.String("mcp.transport"),
		Port:      snapshot.Int("mcp.port"),
		Token:     snapshot.String("mcp.token"),
		URL:       a.deps.MCP.URL(),
		Command:   exe,
		Args:      []string{"mcp-stdio"},
	}
}

// newMCPToken 生成 32 字节的随机令牌（十六进制 64 位）。
func newMCPToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// verifyTwoFactor 用动态码（或恢复码）完成登录。
func (a *api) verifyTwoFactor(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<10)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" {
		fail(w, http.StatusUnprocessableEntity, "请输入动态码")
		return
	}

	a.mu.Lock()
	pending := a.pending
	if pending != nil && time.Now().After(pending.expires) {
		pending = nil
	}
	a.pending = nil
	a.mu.Unlock()
	if pending == nil {
		fail(w, http.StatusConflict, "登录已过期，请重新输入账号密码")
		return
	}

	if err := pending.client.CompleteTwoFactor(r.Context(), code); err != nil {
		// 码错时把这次登录放回去，允许重试（服务端另有 5 次上限）。
		a.mu.Lock()
		a.pending = pending
		a.mu.Unlock()
		if errors.Is(err, cloud.ErrUnauthorized) {
			fail(w, http.StatusUnauthorized, "动态码不正确")
			return
		}
		fail(w, http.StatusBadGateway, "验证失败："+errorText(err))
		return
	}

	// 动态码通过后再拉一次资料（两步验证前拿不到会话）。
	a.logProfileError(pending.client.Me(r.Context()))
	session := pending.client.Session()
	a.deps.Engine.Connect(session.ServerURL, pending.client)
	a.saveLastConnection(session.ServerURL, pending.identifier)
	if err := a.deps.Creds.Save(cloudcreds.Credentials{
		ServerURL: session.ServerURL, Identifier: pending.identifier,
		Email: session.UserEmail, UserUID: session.UserUID, Role: session.Role,
		Nickname:     session.Nickname,
		RefreshToken: session.RefreshToken,
	}, pending.password); err != nil {
		fail(w, http.StatusInternalServerError, "保存连接信息失败")
		return
	}
	// 同步交给前端异步触发，别让它拖慢验证响应。
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
		"serverUrl": session.ServerURL, "email": session.UserEmail, "nickname": session.Nickname,
	}})
}

// ── 同步 ────────────────────────────────────────────────────────────────────

func (a *api) sync(w http.ResponseWriter, r *http.Request) {
	result, err := a.deps.Engine.Sync(r.Context())
	if err != nil {
		if errors.Is(err, syncengine.ErrNotConnected) {
			fail(w, http.StatusConflict, "尚未连接云端")
			return
		}
		fail(w, http.StatusBadGateway, "同步失败："+errorText(err))
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: result})
}

// ── 来源 ────────────────────────────────────────────────────────────────────

type sourceItem struct {
	MapUID       string `json:"mapUid"`
	RemoteUID    string `json:"remoteUid,omitempty"`
	ServerURL    string `json:"serverUrl,omitempty"`
	State        string `json:"state"`
	LastSyncedAt string `json:"lastSyncedAt,omitempty"`
	Deleted      bool   `json:"deleted"`
}

func (a *api) sources(w http.ResponseWriter, r *http.Request) {
	records, err := a.deps.Store.List(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, "读取同步状态失败")
		return
	}
	items := make([]sourceItem, 0, len(records))
	for _, rec := range records {
		item := sourceItem{
			MapUID: rec.MapUID, RemoteUID: rec.RemoteUID, ServerURL: rec.RemoteURL,
			State: string(rec.State), Deleted: rec.Deleted,
		}
		if rec.LastSyncedAt != nil {
			item.LastSyncedAt = rec.LastSyncedAt.UTC().Format(time.RFC3339)
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, envelope{Data: items})
}

// ── 单张导图 ────────────────────────────────────────────────────────────────

func (a *api) upload(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if uid == "" {
		fail(w, http.StatusBadRequest, "缺少导图标识")
		return
	}
	record, err := a.deps.Engine.Upload(r.Context(), uid)
	if err != nil {
		switch {
		case errors.Is(err, syncengine.ErrNotConnected):
			fail(w, http.StatusConflict, "尚未连接云端")
		case errors.Is(err, cloud.ErrUIDConflict):
			fail(w, http.StatusConflict, "云端已有同标识的导图（可能仍在回收站），请先处理")
		default:
			fail(w, http.StatusBadGateway, "上传失败："+errorText(err))
		}
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
		"mapUid": record.MapUID, "remoteUid": record.RemoteUID,
		"state": string(record.State), "version": record.BaseVersion,
	}})
}

type resolveRequest struct {
	KeepLocal bool `json:"keepLocal"`
}

func (a *api) resolve(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	var req resolveRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	if err := a.deps.Engine.ResolveConflict(r.Context(), uid, req.KeepLocal); err != nil {
		if errors.Is(err, syncengine.ErrNotConnected) {
			fail(w, http.StatusConflict, "尚未连接云端")
			return
		}
		fail(w, http.StatusBadGateway, "处理冲突失败："+errorText(err))
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"mapUid": uid, "resolved": true}})
}

// touch 在本地保存成功后把记录标成「有本地改动」。
//
// 前端每次自动保存成功后调用一次。引擎本身靠内容摘要也能发现改动，但界面
// 上的「有本地修改」徽标需要即时状态，不该等到下一次全量同步。
func (a *api) touch(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if uid == "" {
		fail(w, http.StatusBadRequest, "缺少导图标识")
		return
	}
	if err := a.deps.Engine.MarkLocalDirty(r.Context(), uid); err != nil {
		fail(w, http.StatusInternalServerError, "更新同步状态失败")
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"mapUid": uid}})
}

// logProfileError 记录拉取远端资料失败（不致命：顶栏退回显示邮箱）。
func (a *api) logProfileError(_ *cloud.Profile, err error) {
	if err == nil || a.deps.Logger == nil {
		return
	}
	a.deps.Logger.Warn("cloud: profile unavailable", "err", err)
}

// openProject 在浏览器里打开项目主页。
func (a *api) openProject(w http.ResponseWriter, r *http.Request) {
	a.openFixed(w, projectURL)
}

// openDocs 在浏览器里打开部署说明。
func (a *api) openDocs(w http.ResponseWriter, r *http.Request) {
	a.openFixed(w, docsURL)
}

func (a *api) openFixed(w http.ResponseWriter, url string) {
	if err := a.deps.OpenExternal(url); err != nil {
		fail(w, http.StatusInternalServerError, "打开浏览器失败")
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"opened": true}})
}

// ── 更新 ────────────────────────────────────────────────────────────────────

func (a *api) checkUpdates(w http.ResponseWriter, r *http.Request) {
	enabled := a.deps.Updater.Enabled()
	if !enabled {
		// 开发构建、或没有配置更新源的构建：告诉前端「不支持」，界面据此
		// 隐藏入口，而不是显示一个永远失败的重试按钮。
		writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
			"enabled": false, "available": false, "version": a.deps.Version,
		}})
		return
	}
	found, err := a.deps.Updater.Check(r.Context())
	if err != nil {
		fail(w, http.StatusBadGateway, "检查更新失败："+errorText(err))
		return
	}
	data := map[string]any{"enabled": true, "available": found != nil, "version": a.deps.Version}
	if found != nil {
		data["newVersion"] = found.Version
		data["notes"] = found.Notes
		data["date"] = found.Date
	}
	writeJSON(w, http.StatusOK, envelope{Data: data})
}

func (a *api) installUpdate(w http.ResponseWriter, r *http.Request) {
	if err := a.deps.Updater.StartInstall(r.Context()); err != nil {
		fail(w, http.StatusConflict, errorText(err))
		return
	}
	writeJSON(w, http.StatusAccepted, envelope{Data: map[string]any{"started": true}})
}

func (a *api) updateProgress(w http.ResponseWriter, r *http.Request) {
	p := a.deps.Updater.Progress()
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
		"phase": p.Phase, "downloaded": p.Downloaded, "total": p.Total, "error": p.Error,
	}})
}

func (a *api) relaunch(w http.ResponseWriter, r *http.Request) {
	// 先把响应写出去再重启：Relaunch 会结束进程，晚一步前端就只能看到
	// 连接被断开，误以为失败。
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"relaunching": true}})
	a.deps.Updater.Relaunch()
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
