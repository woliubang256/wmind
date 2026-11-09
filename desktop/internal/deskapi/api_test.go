package deskapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloudcreds"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncengine"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	sqliterepo "github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

// ── 测试夹具 ────────────────────────────────────────────────────────────────

type fixture struct {
	api     http.Handler
	engine  *syncengine.Engine
	maps    domain.MapRepo
	ownerID int64
	creds   *CredentialStore
	cloud   *fakeCloudServer
	store   *syncstate.Store
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "wmind.db"))
	if err != nil {
		t.Fatalf("打开数据库: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := migrate.Up(config.DriverSQLite, db, logger); err != nil {
		t.Fatalf("迁移失败: %v", err)
	}
	if err := syncstate.Prepare(t.Context(), db); err != nil {
		t.Fatalf("建同步表失败: %v", err)
	}

	users := sqliterepo.NewUserRepository(db)
	owner, err := users.Create(t.Context(), domain.CreateUserInput{
		UID: "owner-1", Username: "owner", Email: "owner@example.test",
		PasswordHash: "hash", Role: domain.RoleAdmin, Status: domain.UserStatusActive,
		Now: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("创建本地用户失败: %v", err)
	}

	mapRepo := sqliterepo.NewMapRepository(db)
	store := syncstate.NewStore(db)
	engine := syncengine.New(mapRepo, store, owner.ID, logger)
	creds := &CredentialStore{Path: filepath.Join(dir, "cloud.json"), Secret: strings.Repeat("ab", 32)}
	cloud := newFakeCloudServer(t)

	api := New(Deps{
		Engine: engine, Store: store, Creds: creds, Version: "1.0.0",
		// 上次连接信息落到临时文件：登出后预填表单靠它。
		LastConnectionPath: filepath.Join(t.TempDir(), "last-connection.json"),
	})
	return &fixture{api: api, engine: engine, maps: mapRepo, ownerID: owner.ID, creds: creds, cloud: cloud, store: store}
}

func (f *fixture) createMap(t *testing.T, uid, title string) *domain.Map {
	t.Helper()
	created, err := f.maps.Create(t.Context(), domain.CreateMapInput{
		UID: uid, OwnerID: f.ownerID, Title: title,
		Document:  []byte(`{"format":"wmind","title":"` + title + `"}`),
		NodeCount: 1, SizeBytes: 32, Now: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("创建导图失败: %v", err)
	}
	return created
}

// response 是测试用的响应视图：data 保持原始 JSON，既能解成对象也能解成数组。
type response struct {
	status int
	Data   json.RawMessage `json:"data"`
	Error  string          `json:"error"`
}

func (f *fixture) do(t *testing.T, method, path string, body any) response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	f.api.ServeHTTP(rec, req)

	out := response{status: rec.Code}
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("响应不是 JSON: %v (%s)", err, rec.Body.String())
		}
	}
	return out
}

func dataOf(t *testing.T, resp response) map[string]any {
	t.Helper()
	var data map[string]any
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		t.Fatalf("data 不是对象: %v (%s)", err, string(resp.Data))
	}
	return data
}

// ── 假的云端服务器 ──────────────────────────────────────────────────────────

type fakeCloudServer struct {
	t      *testing.T
	key    *rsa.PrivateKey
	server *httptest.Server

	mu    sync.Mutex
	maps  map[string]map[string]any
	docs  map[string][]byte
	login int
	// 两步验证：requireTwoFactor 为真时登录只给挑战令牌。
	requireTwoFactor bool
	twoFactorCode    string
}

func newFakeCloudServer(t *testing.T) *fakeCloudServer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成密钥: %v", err)
	}
	f := &fakeCloudServer{t: t, key: key, maps: map[string]map[string]any{}, docs: map[string][]byte{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/auth/login/challenge", func(w http.ResponseWriter, r *http.Request) {
		jwk := map[string]string{
			"kty": "RSA", "alg": "RSA-OAEP-256",
			"n": base64.RawURLEncoding.EncodeToString(f.key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(f.key.E)).Bytes()),
		}
		writeCloudJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"challengeId": "challenge-abc", "publicKey": jwk, "expiresIn": 120,
		}})
	})
	mux.HandleFunc("/api/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			EncryptedPassword string `json:"encryptedPassword"`
			ChallengeID       string `json:"challengeId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		cipher, err := base64.StdEncoding.DecodeString(req.EncryptedPassword)
		if err != nil {
			writeCloudJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "BAD_REQUEST"}})
			return
		}
		plain, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, f.key, cipher, []byte("wmind/login/v1:"+req.ChallengeID))
		if err != nil || string(plain) != "pw" {
			writeCloudJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]any{"code": "AUTH_INVALID_CREDENTIALS"}})
			return
		}
		f.mu.Lock()
		f.login++
		requireTwoFactor := f.requireTwoFactor
		code := f.twoFactorCode
		f.mu.Unlock()
		if requireTwoFactor {
			writeCloudJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
				"twoFactorRequired": true, "challengeToken": "challenge-token", "expiresIn": 300,
			}})
			return
		}
		_ = code
		writeCloudJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"accessToken": "access-1", "refreshToken": "refresh-1",
			"user": map[string]any{"uid": "remote-user", "email": "a@example.test"},
		}})
	})
	mux.HandleFunc("/api/v1/auth/2fa/verify", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ChallengeToken string `json:"challengeToken"`
			Code           string `json:"code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		want := f.twoFactorCode
		f.mu.Unlock()
		if req.ChallengeToken != "challenge-token" || req.Code != want {
			writeCloudJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]any{"code": "AUTH_2FA_INVALID"}})
			return
		}
		writeCloudJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"accessToken": "access-1", "refreshToken": "refresh-1",
			"user": map[string]any{"uid": "remote-user", "email": "a@example.test", "role": "admin"},
		}})
	})
	mux.HandleFunc("/api/v1/maps", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeCloudJSON(w, http.StatusOK, map[string]any{"data": []any{}})
		case http.MethodPost:
			var req struct {
				UID      string          `json:"uid"`
				Title    string          `json:"title"`
				Document json.RawMessage `json:"document"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			f.mu.Lock()
			if _, exists := f.maps[req.UID]; exists {
				f.mu.Unlock()
				writeCloudJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "MAP_UID_CONFLICT"}})
				return
			}
			hash := sha256.Sum256(req.Document)
			entry := map[string]any{
				"uid": req.UID, "title": req.Title, "version": 1,
				"documentHash": base64.StdEncoding.EncodeToString(hash[:]),
				"updatedAt":    time.Now().UTC().Format(time.RFC3339Nano),
			}
			f.maps[req.UID] = entry
			f.docs[req.UID] = req.Document
			f.mu.Unlock()
			writeCloudJSON(w, http.StatusCreated, map[string]any{"data": entry})
		}
	})
	mux.HandleFunc("/api/v1/maps/", func(w http.ResponseWriter, r *http.Request) {
		uid := strings.TrimPrefix(r.URL.Path, "/api/v1/maps/")
		f.mu.Lock()
		entry, ok := f.maps[uid]
		doc := f.docs[uid]
		f.mu.Unlock()
		if !ok {
			writeCloudJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "MAP_NOT_FOUND"}})
			return
		}
		switch r.Method {
		case http.MethodGet:
			cp := map[string]any{}
			for k, v := range entry {
				cp[k] = v
			}
			cp["document"] = json.RawMessage(doc)
			writeCloudJSON(w, http.StatusOK, map[string]any{"data": cp})
		case http.MethodPut:
			var req struct {
				Version  int             `json:"version"`
				Title    string          `json:"title"`
				Document json.RawMessage `json:"document"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			current, _ := entry["version"].(int)
			if req.Version != current {
				writeCloudJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{
					"code":    "MAP_VERSION_CONFLICT",
					"details": map[string]any{"currentVersion": current, "currentHash": entry["documentHash"]},
				}})
				return
			}
			hash := sha256.Sum256(req.Document)
			f.mu.Lock()
			entry["version"] = current + 1
			entry["title"] = req.Title
			entry["documentHash"] = base64.StdEncoding.EncodeToString(hash[:])
			f.maps[uid] = entry
			f.docs[uid] = req.Document
			f.mu.Unlock()
			writeCloudJSON(w, http.StatusOK, map[string]any{"data": entry})
		}
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func writeCloudJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ── 用例 ────────────────────────────────────────────────────────────────────

func TestStatusBeforeConnect(t *testing.T) {
	f := newFixture(t)
	resp := f.do(t, http.MethodGet, "/desktop/status", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("状态 = %d %s", resp.status, string(resp.Data))
	}
	data := dataOf(t, resp)
	if connected, _ := data["cloud"].(map[string]any)["connected"].(bool); connected {
		t.Fatalf("未连接时不应显示已连接: %#v", data)
	}
	if mode, _ := data["mode"].(string); mode != "local" {
		t.Fatalf("模式 = %q", mode)
	}
}

func TestConnectStoresCredentialsAndSyncs(t *testing.T) {
	f := newFixture(t)
	f.createMap(t, "map-1", "本地图")

	resp := f.do(t, http.MethodPost, "/desktop/cloud/connect", map[string]any{
		"serverUrl": f.cloud.server.URL, "identifier": "a@example.test", "password": "pw",
	})
	if resp.status != http.StatusOK {
		t.Fatalf("连接 = %d %s", resp.status, string(resp.Data))
	}
	if !f.engine.Connected() {
		t.Fatal("引擎没有连上云端")
	}
	stored, err := f.creds.Load()
	if err != nil || stored == nil {
		t.Fatalf("凭据没有保存: %+v %v", stored, err)
	}
	if stored.ServerURL != f.cloud.server.URL {
		t.Fatalf("保存的地址不对: %+v", stored)
	}
	if _, err := stored.Decrypt(f.creds.Secret); err != nil {
		t.Fatalf("保存的密码解不开: %v", err)
	}

	// 连接不会把本机所有导图悄悄传上去：本地图仍是本地图，要用户显式上传。
	if len(f.cloud.maps) != 0 {
		t.Fatalf("连接不应自动上传本地导图，云端实际 %d 张", len(f.cloud.maps))
	}
}

func TestConnectRejectsBadCredentials(t *testing.T) {
	f := newFixture(t)
	resp := f.do(t, http.MethodPost, "/desktop/cloud/connect", map[string]any{
		"serverUrl": f.cloud.server.URL, "identifier": "a@example.test", "password": "wrong",
	})
	if resp.status != http.StatusUnauthorized {
		t.Fatalf("密码错误期望 401，实际 %d %s", resp.status, string(resp.Data))
	}
	if f.engine.Connected() {
		t.Fatal("登录失败不应留下连接")
	}
}

func TestUploadAndSources(t *testing.T) {
	f := newFixture(t)
	f.connect(t)
	f.createMap(t, "map-2", "待上传")

	resp := f.do(t, http.MethodPost, "/desktop/maps/map-2/upload", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("上传 = %d %s", resp.status, string(resp.Data))
	}
	data := dataOf(t, resp)
	if data["remoteUid"] != "map-2" || data["state"] != "synced" {
		t.Fatalf("上传结果不对: %#v", data)
	}

	resp = f.do(t, http.MethodGet, "/desktop/maps/sources", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("来源列表 = %d %s", resp.status, string(resp.Data))
	}
	if !strings.Contains(string(resp.Data), `"mapUid":"map-2"`) {
		t.Fatalf("来源列表里没有这张图: %s", resp.Data)
	}
}

func TestSyncPushesLocalChanges(t *testing.T) {
	f := newFixture(t)
	f.connect(t)
	created := f.createMap(t, "map-3", "第一版")
	if resp := f.do(t, http.MethodPost, "/desktop/maps/map-3/upload", nil); resp.Error != "" {
		t.Fatalf("上传失败: %s", resp.Error)
	}

	// 模拟编辑器保存 + 前端 touch。
	if _, err := f.maps.UpdateWithVersion(t.Context(), domain.UpdateMapInput{
		UID: "map-3", OwnerID: f.ownerID, Title: "第二版",
		Document:  []byte(`{"format":"wmind","title":"第二版"}`),
		NodeCount: 1, SizeBytes: 40, ExpectedVersion: created.Version, Now: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("本地保存失败: %v", err)
	}
	if resp := f.do(t, http.MethodPost, "/desktop/maps/map-3/touch", nil); resp.status != http.StatusOK {
		t.Fatalf("touch = %d %s", resp.status, string(resp.Data))
	}

	resp := f.do(t, http.MethodPost, "/desktop/sync", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("同步 = %d %s", resp.status, string(resp.Data))
	}
	data := dataOf(t, resp)
	if pushed, _ := data["Pushed"].(float64); pushed != 1 {
		t.Fatalf("应当推送 1 条: %#v", data)
	}
	if got, _ := f.cloud.maps["map-3"]["version"].(int); got != 2 {
		t.Fatalf("云端版本 = %d; 期望 2", got)
	}
}

func TestDisconnectClearsCredentials(t *testing.T) {
	f := newFixture(t)
	f.connect(t)

	resp := f.do(t, http.MethodPost, "/desktop/cloud/disconnect", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("断开 = %d %s", resp.status, string(resp.Data))
	}
	if f.engine.Connected() {
		t.Fatal("断开后引擎仍处于连接状态")
	}
	if stored, err := f.creds.Load(); err != nil || stored != nil {
		t.Fatalf("凭据没有清除: %+v %v", stored, err)
	}
}

func TestSyncWithoutConnectionIsConflict(t *testing.T) {
	f := newFixture(t)
	resp := f.do(t, http.MethodPost, "/desktop/sync", nil)
	if resp.status != http.StatusConflict {
		t.Fatalf("未连接同步期望 409，实际 %d %s", resp.status, string(resp.Data))
	}
}

func (f *fixture) connect(t *testing.T) {
	t.Helper()
	resp := f.do(t, http.MethodPost, "/desktop/cloud/connect", map[string]any{
		"serverUrl": f.cloud.server.URL, "identifier": "a@example.test", "password": "pw",
	})
	if resp.status != http.StatusOK {
		t.Fatalf("连接失败: %d %s", resp.status, string(resp.Data))
	}
}

var _ = context.Background

// ── 更新 ────────────────────────────────────────────────────────────────────

type fakeUpdater struct {
	enabled    bool
	found      *UpdateInfo
	checkErr   error
	installErr error
	progress   UpdateProgress
	installs   int
	relaunched bool
}

func (f *fakeUpdater) Enabled() bool { return f.enabled }
func (f *fakeUpdater) Check(context.Context) (*UpdateInfo, error) {
	return f.found, f.checkErr
}
func (f *fakeUpdater) StartInstall(context.Context) error {
	if f.installErr != nil {
		return f.installErr
	}
	f.installs++
	f.progress = UpdateProgress{Phase: "downloading", Downloaded: 512, Total: 2048}
	return nil
}
func (f *fakeUpdater) Progress() UpdateProgress { return f.progress }
func (f *fakeUpdater) Relaunch()                { f.relaunched = true }

func newUpdateFixture(t *testing.T, updater *fakeUpdater) http.Handler {
	t.Helper()
	base := newFixture(t)
	return New(Deps{
		Engine: base.engine, Store: base.store, Creds: base.creds, Version: "1.0.0", Updater: updater,
	})
}

func TestCheckUpdatesWhenDisabled(t *testing.T) {
	updater := &fakeUpdater{enabled: false}
	api := newUpdateFixture(t, updater)

	req := httptest.NewRequest(http.MethodGet, "/desktop/updates/check", nil)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("状态 = %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data["enabled"] != false || body.Data["available"] != false {
		t.Fatalf("不支持的构建应当明确返回 enabled=false: %#v", body.Data)
	}
}

func TestCheckUpdatesFindsVersion(t *testing.T) {
	updater := &fakeUpdater{enabled: true, found: &UpdateInfo{Version: "1.1.0", Notes: "- 新功能", Date: "2026-11-09T00:00:00Z"}}
	api := newUpdateFixture(t, updater)

	req := httptest.NewRequest(http.MethodGet, "/desktop/updates/check", nil)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)

	var body struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data["available"] != true || body.Data["newVersion"] != "1.1.0" || body.Data["notes"] != "- 新功能" {
		t.Fatalf("检查结果不对: %#v", body.Data)
	}
}

func TestInstallUpdateAndProgress(t *testing.T) {
	updater := &fakeUpdater{enabled: true, found: &UpdateInfo{Version: "1.1.0"}}
	api := newUpdateFixture(t, updater)

	req := httptest.NewRequest(http.MethodPost, "/desktop/updates/install", nil)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("安装 = %d %s", rec.Code, rec.Body.String())
	}
	if updater.installs != 1 {
		t.Fatalf("应当启动一次安装，实际 %d", updater.installs)
	}

	req = httptest.NewRequest(http.MethodGet, "/desktop/updates/progress", nil)
	rec = httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	var body struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data["phase"] != "downloading" || body.Data["total"].(float64) != 2048 {
		t.Fatalf("进度不对: %#v", body.Data)
	}
}

func TestInstallUpdateWithoutPendingIsConflict(t *testing.T) {
	updater := &fakeUpdater{enabled: true, installErr: errors.New("没有待安装的更新")}
	api := newUpdateFixture(t, updater)

	req := httptest.NewRequest(http.MethodPost, "/desktop/updates/install", nil)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("没有待安装更新期望 409，实际 %d", rec.Code)
	}
}

func TestRelaunchReportsBeforeRestarting(t *testing.T) {
	updater := &fakeUpdater{enabled: true}
	api := newUpdateFixture(t, updater)

	req := httptest.NewRequest(http.MethodPost, "/desktop/updates/relaunch", nil)
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("重启 = %d", rec.Code)
	}
	if !updater.relaunched {
		t.Fatal("没有触发重启")
	}
}

// 两步验证：密码通过后先要动态码，验证成功才真正连上并保存凭据。
func TestConnectWithTwoFactor(t *testing.T) {
	f := newFixture(t)
	// 让假云端的登录返回「需要两步验证」。
	f.cloud.requireTwoFactor = true
	f.cloud.twoFactorCode = "123456"

	resp := f.do(t, http.MethodPost, "/desktop/cloud/connect", map[string]any{
		"serverUrl": f.cloud.server.URL, "identifier": "a@example.test", "password": "pw",
	})
	if resp.status != http.StatusOK {
		t.Fatalf("连接 = %d %s", resp.status, string(resp.Data))
	}
	data := dataOf(t, resp)
	if data["twoFactorRequired"] != true {
		t.Fatalf("应当提示需要两步验证: %#v", data)
	}
	if f.engine.Connected() {
		t.Fatal("还没验证动态码就不该连上云端")
	}
	if stored, _ := f.creds.Load(); stored != nil {
		t.Fatal("还没验证动态码就不该保存凭据")
	}

	// 动态码错误：401，且可以重试。
	resp = f.do(t, http.MethodPost, "/desktop/cloud/verify-2fa", map[string]any{"code": "000000"})
	if resp.status != http.StatusUnauthorized {
		t.Fatalf("错误动态码期望 401，实际 %d %s / err=%s", resp.status, string(resp.Data), resp.Error)
	}

	// 正确动态码：连上并保存凭据。
	resp = f.do(t, http.MethodPost, "/desktop/cloud/verify-2fa", map[string]any{"code": f.cloud.twoFactorCode})
	if resp.status != http.StatusOK {
		t.Fatalf("验证 = %d %s", resp.status, string(resp.Data))
	}
	if !f.engine.Connected() {
		t.Fatal("验证通过后应当连上云端")
	}
	stored, err := f.creds.Load()
	if err != nil || stored == nil || stored.Email != "a@example.test" {
		t.Fatalf("验证通过后应保存凭据: %+v %v", stored, err)
	}
}

// 没有待验证的登录时，直接提交动态码应当明确报错，而不是静默成功。
func TestVerifyTwoFactorWithoutPending(t *testing.T) {
	f := newFixture(t)
	resp := f.do(t, http.MethodPost, "/desktop/cloud/verify-2fa", map[string]any{"code": "123456"})
	if resp.status != http.StatusConflict {
		t.Fatalf("没有待验证登录期望 409，实际 %d", resp.status)
	}
}

// ── 凭据存储 ────────────────────────────────────────────────────────────────

type fakeSecrets struct {
	data map[string][]byte
	err  error
}

func (f *fakeSecrets) Set(key string, value []byte) error {
	if f.err != nil {
		return f.err
	}
	if f.data == nil {
		f.data = map[string][]byte{}
	}
	f.data[key] = value
	return nil
}

func (f *fakeSecrets) Get(key string) ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	value, ok := f.data[key]
	if !ok {
		return nil, errors.New("not found")
	}
	return value, nil
}

func (f *fakeSecrets) Delete(key string) error {
	if f.data != nil {
		delete(f.data, key)
	}
	return nil
}

// 有系统凭据存储时优先用它：重装应用、清掉数据目录之后登录信息仍然在。
func TestCredentialsPreferKeychain(t *testing.T) {
	dir := t.TempDir()
	keychain := &fakeSecrets{}
	store := &CredentialStore{Path: filepath.Join(dir, "cloud.json"), Secret: strings.Repeat("ab", 32), Keychain: keychain}

	creds := cloudcreds.Credentials{ServerURL: "https://cloud.example", Identifier: "a@example.test", Email: "a@example.test", Role: "admin"}
	if err := store.Save(creds, "pw"); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if len(keychain.data[credentialKey]) == 0 {
		t.Fatal("凭据应当写进系统存储")
	}
	if _, err := os.Stat(filepath.Join(dir, "cloud.json")); err == nil {
		t.Fatal("系统存储成功时不该再写文件（两份真源会漂移）")
	}

	loaded, err := store.Load()
	if err != nil || loaded == nil {
		t.Fatalf("读取失败: %v", err)
	}
	if loaded.ServerURL != creds.ServerURL || loaded.Email != creds.Email || loaded.Role != "admin" {
		t.Fatalf("读回内容不对: %+v", loaded)
	}
	if loaded.Password != "pw" {
		t.Fatalf("系统存储里应当有密码（由系统加密）: %q", loaded.Password)
	}

	// 清掉数据目录里的文件不影响读取：这正是「重装后登录还在」的场景。
	if err := store.Clear(); err != nil {
		t.Fatalf("清除失败: %v", err)
	}
	if loaded, err := store.Load(); err != nil || loaded != nil {
		t.Fatalf("清除后应当没有凭据: %+v %v", loaded, err)
	}
}

// 系统存储不可用（Linux 没有 libsecret）时退回加密文件。
func TestCredentialsFallbackToEncryptedFile(t *testing.T) {
	dir := t.TempDir()
	store := &CredentialStore{
		Path: filepath.Join(dir, "cloud.json"), Secret: strings.Repeat("ab", 32),
		Keychain: &fakeSecrets{err: errors.New("no secret service")},
	}
	creds := cloudcreds.Credentials{ServerURL: "https://cloud.example", Identifier: "a@example.test"}
	if err := store.Save(creds, "pw"); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "cloud.json"))
	if err != nil {
		t.Fatalf("应当退回写文件: %v", err)
	}
	if strings.Contains(string(raw), `"pw"`) {
		t.Fatal("回退文件里的密码必须是加密的")
	}
	loaded, err := store.Load()
	if err != nil || loaded == nil || loaded.ServerURL != creds.ServerURL {
		t.Fatalf("回退读取失败: %+v %v", loaded, err)
	}
	if password, err := loaded.Decrypt(store.Secret); err != nil || password != "pw" {
		t.Fatalf("回退密码解不开: %q %v", password, err)
	}
}

// 登出后仍记住服务器与账号：下次登录表单要预填，不用重敲。
func TestDisconnectKeepsLastConnection(t *testing.T) {
	f := newFixture(t)
	resp := f.do(t, http.MethodPost, "/desktop/cloud/connect", map[string]any{
		"serverUrl": f.cloud.server.URL, "identifier": "a@example.test", "password": "pw",
	})
	if resp.status != http.StatusOK {
		t.Fatalf("连接 = %d %s", resp.status, string(resp.Data))
	}

	resp = f.do(t, http.MethodPost, "/desktop/cloud/disconnect", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("断开 = %d", resp.status)
	}

	status := dataOf(t, f.do(t, http.MethodGet, "/desktop/status", nil))
	cloudStatus := status["cloud"].(map[string]any)
	if cloudStatus["connected"] != false {
		t.Fatalf("断开后不应还是已连接: %#v", cloudStatus)
	}
	if cloudStatus["lastServerUrl"] != f.cloud.server.URL || cloudStatus["lastIdentifier"] != "a@example.test" {
		t.Fatalf("应当记住上次的服务器与账号: %#v", cloudStatus)
	}
}
