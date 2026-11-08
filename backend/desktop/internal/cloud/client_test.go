package cloud

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCloud 模拟自托管服务器的登录与导图接口。
//
// 登录走与真实服务端同一条路径：发挑战 → 用 RSA-OAEP 私钥解密 → 校验明文。
// 客户端如果偷懒发明文，这里会直接失败。
type fakeCloud struct {
	t        *testing.T
	key      *rsa.PrivateKey
	server   *httptest.Server
	password string

	mu            sync.Mutex
	challengeID   string
	decrypted     string
	label         string
	loginAttempts int
	authHeader    string
	cookieHeader  string
}

func newFakeCloud(t *testing.T, password string) *fakeCloud {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成测试密钥: %v", err)
	}
	f := &fakeCloud{t: t, key: key, password: password}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/auth/login/challenge", f.handleChallenge)
	mux.HandleFunc("/api/v1/auth/login", f.handleLogin)
	mux.HandleFunc("/api/v1/auth/refresh", f.handleRefresh)
	mux.HandleFunc("/api/v1/maps", f.handleMaps)
	mux.HandleFunc("/api/v1/maps/", f.handleMap)
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeCloud) url() string { return f.server.URL }

func (f *fakeCloud) handleChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	f.mu.Lock()
	f.challengeID = "challenge-0123456789abcdef0123456789abcdef"
	id := f.challengeID
	f.mu.Unlock()

	jwk := map[string]string{
		"kty": "RSA",
		"alg": "RSA-OAEP-256",
		"n":   base64.RawURLEncoding.EncodeToString(f.key.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(f.key.E)).Bytes()),
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{"challengeId": id, "publicKey": jwk, "expiresIn": 120},
	})
}

func (f *fakeCloud) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Identifier        string `json:"identifier"`
		ChallengeID       string `json:"challengeId"`
		EncryptedPassword string `json:"encryptedPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "BAD_REQUEST"}})
		return
	}
	f.mu.Lock()
	f.loginAttempts++
	f.challengeID = req.ChallengeID
	f.mu.Unlock()

	cipher, err := base64.StdEncoding.DecodeString(req.EncryptedPassword)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "BAD_REQUEST"}})
		return
	}
	label := "wmind/login/v1:" + req.ChallengeID
	plain, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, f.key, cipher, []byte(label))
	if err != nil {
		// 标签不对或不是 RSA-OAEP：真实服务端同样拒绝。
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "AUTH_LOGIN_CHALLENGE_INVALID"}})
		return
	}
	f.mu.Lock()
	f.decrypted = string(plain)
	f.label = label
	f.mu.Unlock()

	if string(plain) != f.password {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]any{"code": "AUTH_INVALID_CREDENTIALS"}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"accessToken": "access-1", "refreshToken": "refresh-1",
		"user": map[string]any{"uid": "user-1", "email": "a@example.test"},
	}})
}

func (f *fakeCloud) handleRefresh(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"accessToken": "access-2", "refreshToken": "refresh-2",
		"user": map[string]any{"uid": "user-1", "email": "a@example.test"},
	}})
}

func (f *fakeCloud) handleMaps(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.authHeader = r.Header.Get("Authorization")
	f.mu.Unlock()

	switch r.Method {
	case http.MethodGet:
		since := r.URL.Query().Get("updated_since")
		if since == "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{"code": "VALIDATION_FAILED"}})
			return
		}
		if _, err := time.Parse(time.RFC3339Nano, since); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{"code": "VALIDATION_FAILED"}})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": []any{
			map[string]any{"uid": "remote-1", "title": "云端图", "version": 3, "documentHash": "hash-3", "deleted": false, "updatedAt": "2026-11-08T10:00:00Z"},
			map[string]any{"uid": "remote-2", "title": "云端已删", "version": 5, "documentHash": "hash-5", "deleted": true, "updatedAt": "2026-11-08T11:00:00Z"},
		}})
	case http.MethodPost:
		var req struct {
			UID      string          `json:"uid"`
			Title    string          `json:"title"`
			Document json.RawMessage `json:"document"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "BAD_REQUEST"}})
			return
		}
		if req.UID == "taken" {
			writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "MAP_UID_CONFLICT"}})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{
			"uid": req.UID, "title": req.Title, "version": 1, "documentHash": "hash-new", "updatedAt": "2026-11-08T12:00:00Z",
		}})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (f *fakeCloud) handleMap(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.cookieHeader = r.Header.Get("Cookie")
	f.mu.Unlock()

	uid := strings.TrimPrefix(r.URL.Path, "/api/v1/maps/")
	switch r.Method {
	case http.MethodGet:
		if uid == "gone" {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "MAP_NOT_FOUND"}})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"uid": uid, "title": "云端图", "version": 4, "documentHash": "hash-4",
			"document": map[string]any{"title": "云端图"}, "updatedAt": "2026-11-08T10:00:00Z",
		}})
	case http.MethodPut:
		var req struct {
			Version  int             `json:"version"`
			Title    string          `json:"title"`
			Document json.RawMessage `json:"document"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"code": "BAD_REQUEST"}})
			return
		}
		if req.Version != 4 {
			writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{
				"code": "MAP_VERSION_CONFLICT",
				"details": map[string]any{
					"currentVersion": 4, "currentHash": "hash-4",
					"currentUpdatedAt": "2026-11-08T10:00:00Z",
				},
			}})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"uid": uid, "title": req.Title, "version": 5, "documentHash": "hash-5", "updatedAt": "2026-11-08T13:00:00Z",
		}})
	case http.MethodDelete:
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func TestLoginEncryptsPassword(t *testing.T) {
	fake := newFakeCloud(t, "correct-horse")
	client, err := Login(t.Context(), fake.url(), "a@example.test", "correct-horse")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	fake.mu.Lock()
	decrypted, label := fake.decrypted, fake.label
	fake.mu.Unlock()
	if decrypted != "correct-horse" {
		t.Fatalf("服务端解出的密码 = %q", decrypted)
	}
	if !strings.HasPrefix(label, "wmind/login/v1:") {
		t.Fatalf("标签没有绑定挑战: %q", label)
	}
	session := client.Session()
	if session.AccessToken != "access-1" || session.RefreshToken != "refresh-1" {
		t.Fatalf("会话没有拿到令牌: %+v", session)
	}
	if session.UserUID != "user-1" {
		t.Fatalf("会话没有拿到用户: %+v", session)
	}
}

func TestLoginRejectsWrongPassword(t *testing.T) {
	fake := newFakeCloud(t, "correct-horse")
	if _, err := Login(t.Context(), fake.url(), "a@example.test", "wrong"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("密码错误应返回 ErrUnauthorized，实际 %v", err)
	}
}

func TestListChangedSendsCursorAndParses(t *testing.T) {
	fake := newFakeCloud(t, "pw")
	client, err := Login(t.Context(), fake.url(), "a@example.test", "pw")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	since := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	maps, err := client.ListChanged(t.Context(), since)
	if err != nil {
		t.Fatalf("增量拉取失败: %v", err)
	}
	if len(maps) != 2 {
		t.Fatalf("应当拿到 2 张图，实际 %d", len(maps))
	}
	if !maps[1].Deleted {
		t.Fatalf("已删除标记丢了: %+v", maps[1])
	}
	fake.mu.Lock()
	auth := fake.authHeader
	fake.mu.Unlock()
	if auth != "Bearer access-1" {
		t.Fatalf("请求没有带访问令牌: %q", auth)
	}
}

func TestSaveConflictCarriesDetails(t *testing.T) {
	fake := newFakeCloud(t, "pw")
	client, err := Login(t.Context(), fake.url(), "a@example.test", "pw")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	_, err = client.Save(t.Context(), "remote-1", 3, "标题", json.RawMessage(`{"title":"标题"}`))
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("期望 *ConflictError，实际 %v", err)
	}
	if conflict.CurrentVersion != 4 || conflict.CurrentHash != "hash-4" {
		t.Fatalf("冲突详情没有解析出来: %+v", conflict)
	}

	// 版本对得上就能保存成功。
	saved, err := client.Save(t.Context(), "remote-1", 4, "标题", json.RawMessage(`{"title":"标题"}`))
	if err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if saved.Version != 5 || saved.DocumentHash != "hash-5" {
		t.Fatalf("保存结果不对: %+v", saved)
	}
}

func TestGetMapAndMissing(t *testing.T) {
	fake := newFakeCloud(t, "pw")
	client, err := Login(t.Context(), fake.url(), "a@example.test", "pw")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	got, err := client.GetMap(t.Context(), "remote-1")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if got.Version != 4 || len(got.Document) == 0 {
		t.Fatalf("读取结果不对: %+v", got)
	}
	if _, err := client.GetMap(t.Context(), "gone"); !errors.Is(err, ErrMapNotFound) {
		t.Fatalf("404 应返回 ErrMapNotFound，实际 %v", err)
	}
}

func TestUploadKeepsUIDAndReportsConflict(t *testing.T) {
	fake := newFakeCloud(t, "pw")
	client, err := Login(t.Context(), fake.url(), "a@example.test", "pw")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	uploaded, err := client.Upload(t.Context(), "local-1", "本地图", json.RawMessage(`{"title":"本地图"}`))
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if uploaded.UID != "local-1" || uploaded.Version != 1 {
		t.Fatalf("上传结果不对: %+v", uploaded)
	}
	if _, err := client.Upload(t.Context(), "taken", "x", json.RawMessage(`{}`)); !errors.Is(err, ErrUIDConflict) {
		t.Fatalf("uid 冲突应返回 ErrUIDConflict，实际 %v", err)
	}
}

// 断网必须与「账号被踢」区分开：前者可重试，后者要重新登录。
func TestUnreachableServerIsUnavailable(t *testing.T) {
	fake := newFakeCloud(t, "pw")
	client, err := Login(t.Context(), fake.url(), "a@example.test", "pw")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	fake.server.Close()
	if _, err := client.ListChanged(t.Context(), time.Now()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("不可达应返回 ErrUnavailable，实际 %v", err)
	}
}

func TestNormalizeBaseURL(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "https://cloud.example/", want: "https://cloud.example"},
		{in: "cloud.example", want: "https://cloud.example"},
		{in: "http://127.0.0.1:8080", want: "http://127.0.0.1:8080"},
		{in: "https://cloud.example/wmind/", want: "https://cloud.example/wmind"},
		{in: "  https://cloud.example  ", want: "https://cloud.example"},
		{in: "", wantErr: true},
		{in: "ftp://cloud.example", wantErr: true},
	}
	for _, tc := range cases {
		got, err := normalizeBaseURL(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%q 应当报错", tc.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%q 解析失败: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("%q = %q; 期望 %q", tc.in, got, tc.want)
		}
	}
}
