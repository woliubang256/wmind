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
	"net/http"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/cloudcreds"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncengine"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
)

// CredentialStore 读写云端连接凭据。
type CredentialStore struct {
	Path   string
	Secret string
}

// Load 读取凭据；没有连接时返回 nil。
func (c *CredentialStore) Load() (*cloudcreds.Credentials, error) {
	return cloudcreds.Load(c.Path, c.Secret)
}

// Save 保存凭据。
func (c *CredentialStore) Save(creds cloudcreds.Credentials, password string) error {
	return cloudcreds.Save(c.Path, c.Secret, creds, password)
}

// Clear 删除凭据。
func (c *CredentialStore) Clear() error { return cloudcreds.Clear(c.Path) }

// Deps 是接口需要的依赖。
type Deps struct {
	Engine  *syncengine.Engine
	Store   *syncstate.Store
	Creds   *CredentialStore
	Version string
	// Login 覆盖登录实现，测试用；为空时用 cloud.Login。
	Login func(ctx context.Context, serverURL, identifier, password string) (*cloud.Client, error)
}

// New 构造 /desktop/ 的 Handler。
func New(deps Deps) http.Handler {
	a := &api{deps: deps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /desktop/status", a.status)
	mux.HandleFunc("POST /desktop/cloud/connect", a.connect)
	mux.HandleFunc("POST /desktop/cloud/disconnect", a.disconnect)
	mux.HandleFunc("POST /desktop/sync", a.sync)
	mux.HandleFunc("GET /desktop/maps/sources", a.sources)
	mux.HandleFunc("POST /desktop/maps/{uid}/upload", a.upload)
	mux.HandleFunc("POST /desktop/maps/{uid}/resolve", a.resolve)
	mux.HandleFunc("POST /desktop/maps/{uid}/touch", a.touch)
	return mux
}

type api struct {
	deps Deps
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
	Connected    bool   `json:"connected"`
	ServerURL    string `json:"serverUrl,omitempty"`
	Email        string `json:"email,omitempty"`
	LastSyncedAt string `json:"lastSyncedAt,omitempty"`
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

	if creds, err := a.deps.Creds.Load(); err == nil && creds != nil {
		resp.Cloud.Email = creds.Email
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

	session := client.Session()
	a.deps.Engine.Connect(session.ServerURL, client)
	if err := a.deps.Creds.Save(cloudcreds.Credentials{
		ServerURL: session.ServerURL, Identifier: req.Identifier,
		Email: session.UserEmail, UserUID: session.UserUID,
		RefreshToken: session.RefreshToken,
	}, req.Password); err != nil {
		fail(w, http.StatusInternalServerError, "保存连接信息失败")
		return
	}

	// 连接成功后立刻同步一次；失败不算连接失败——离线优先，用户可以稍后重试。
	result, syncErr := a.deps.Engine.Sync(r.Context())
	writeJSON(w, http.StatusOK, envelope{Data: map[string]any{
		"serverUrl": session.ServerURL,
		"email":     session.UserEmail,
		"sync":      result,
		"syncError": errorText(syncErr),
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

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
