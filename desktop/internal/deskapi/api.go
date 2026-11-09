// Package deskapi 提供桌面端专有的 HTTP 接口，挂在 /desktop/ 下。
//
// 它们不属于 Web API：前端只在桌面壳里调用，用来连接云端、触发同步、上传
// 单张导图、查询本地/云端来源。全部由 localserver 的壳令牌 cookie 守着
// （同源、HttpOnly），因此这里不再单独鉴权。
package deskapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/cloudcreds"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncengine"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
)

// SecretStore 是系统的凭据存储（macOS 钥匙串 / Windows 凭据管理器 /
// Linux Secret Service）。由桌面入口注入，测试里用假实现。
type SecretStore interface {
	Set(key string, value []byte) error
	Get(key string) ([]byte, error)
	Delete(key string) error
}

// lastConnection 记住上次登录过的服务器与账号，**登出后不清**：下次登录时
// 预填，省得用户重敲地址。只存这两项，不含任何凭据。
type lastConnection struct {
	ServerURL  string `json:"serverUrl"`
	Identifier string `json:"identifier"`
}

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

// credentialKey 是凭据在系统存储里的键。
const credentialKey = "cloud-connection"

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
// 优先放**系统凭据存储**：它由系统按用户加密，比应用数据目录里的文件更安全，
// 也不会因为重装应用、清理数据目录而丢（Keychain 里的条目独立存在）。
// 没有可用凭据存储时（如 Linux 没有 libsecret）退回加密文件。
type CredentialStore struct {
	Path     string
	Secret   string
	Keychain SecretStore
}

// Load 读取凭据：先问系统存储，再退回文件；都没有时返回 nil。
func (c *CredentialStore) Load() (*cloudcreds.Credentials, error) {
	if c.Keychain != nil {
		if raw, err := c.Keychain.Get(credentialKey); err == nil && len(raw) > 0 {
			var creds cloudcreds.Credentials
			if err := json.Unmarshal(raw, &creds); err == nil && creds.ServerURL != "" {
				return &creds, nil
			}
		}
	}
	return cloudcreds.Load(c.Path, c.Secret)
}

// Save 保存凭据：系统存储可用时写它（含密码，由系统加密），否则写加密文件。
func (c *CredentialStore) Save(creds cloudcreds.Credentials, password string) error {
	if password != "" {
		creds.Password = password
	}
	if c.Keychain != nil {
		if raw, err := json.Marshal(creds); err == nil && len(raw) <= 2560 {
			if err := c.Keychain.Set(credentialKey, raw); err == nil {
				// 系统存储成功就不再写文件：两份真源会漂移。
				_ = cloudcreds.Clear(c.Path)
				return nil
			}
		}
	}
	return cloudcreds.Save(c.Path, c.Secret, creds, password)
}

// Clear 删除凭据（两处都清）。
func (c *CredentialStore) Clear() error {
	if c.Keychain != nil {
		_ = c.Keychain.Delete(credentialKey)
	}
	return cloudcreds.Clear(c.Path)
}

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
	mux.HandleFunc("POST /desktop/cloud/open-site", a.openSite)
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
	return mux
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

	client, err := a.login(r.Context(), req.ServerURL, req.Identifier, req.Password)
	if err != nil {
		switch {
		case errors.Is(err, cloud.ErrUnauthorized):
			fail(w, http.StatusUnauthorized, "账号或密码不正确")
		case errors.Is(err, cloud.ErrUnavailable):
			fail(w, http.StatusBadGateway, "连接服务器失败，请检查地址与网络")
		default:
			fail(w, http.StatusBadGateway, "连接服务器失败")
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

	// 这里**不做同步**：首次同步要拉全部导图，几秒到几十秒，放在登录响应里
	// 会让「登录」按钮一直转（两步验证时尤其明显）。前端登录成功后再异步
	// 触发 /desktop/sync，失败也不影响已建立的连接。
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
		"serverUrl": session.ServerURL,
		"email":     session.UserEmail,
		"nickname":  session.Nickname,
	}})
}

func (a *api) disconnect(w http.ResponseWriter, r *http.Request) {
	a.deps.Engine.Disconnect()
	if err := a.deps.Creds.Clear(); err != nil {
		fail(w, http.StatusInternalServerError, "清除连接信息失败")
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"connected": false}})
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

// openSite 在系统浏览器里打开远程服务器的管理后台。
//
// 桌面端只跟本机回环后端说话，远程站点的管理界面不搬进客户端——
// 用默认浏览器打开最直接，权限体系也还是服务器自己的。
func (a *api) openSite(w http.ResponseWriter, r *http.Request) {
	creds, err := a.deps.Creds.Load()
	if err != nil || creds == nil || creds.ServerURL == "" {
		fail(w, http.StatusConflict, "尚未连接云端")
		return
	}
	if creds.Role != "admin" {
		fail(w, http.StatusForbidden, "只有管理员可以打开网站设置")
		return
	}
	if err := a.deps.OpenExternal(creds.ServerURL + "/admin/settings"); err != nil {
		fail(w, http.StatusInternalServerError, "打开浏览器失败")
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{"opened": true}})
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
