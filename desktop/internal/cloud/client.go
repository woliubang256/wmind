// Package cloud 是桌面端的云端客户端：以「同步客户端」的身份访问自托管服务器。
//
// 它只做一件事——把本地导图和云端导图对齐所需的 HTTP 调用，不掺业务规则。
// 三条约束：
//
//  1. **登录必须走应用层加密**：服务端拒绝明文密码（docs/04 §3.3）。这里用
//     一次性挑战的 RSA-OAEP 公钥加密密码，和浏览器完全同一条路径。
//  2. **令牌只放在内存里**：调用方负责持久化（本地 secrets 文件，0600）。
//  3. **不静默降级**：401 抛 ErrUnauthorized 让上层决定刷新还是断开，网络
//     错误抛 ErrUnavailable——两者语义不同，混在一起会让「断网」看起来像
//     「账号被踢」。
package cloud

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ErrUnauthorized 表示服务端拒绝了当前令牌（需要刷新或重新登录）。
var ErrUnauthorized = errors.New("cloud: unauthorized")

// ErrUnavailable 表示服务端不可达或返回了无法理解的内容。
var ErrUnavailable = errors.New("cloud: unavailable")

// ConflictError 是保存时版本冲突的服务端详情。
type ConflictError struct {
	CurrentVersion   int
	CurrentHash      string
	CurrentUpdatedAt string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("cloud: version conflict (current %d)", e.CurrentVersion)
}

// Map 是云端导图。
type Map struct {
	UID   string `json:"uid"`
	Title string `json:"title"`
	// ThumbnailURL 是服务器上的缩略图（站内相对路径）。拉取时一并落本地，
	// 列表里才有图可显示。
	ThumbnailURL string          `json:"thumbnailUrl"`
	NodeCount    int             `json:"nodeCount"`
	Version      int             `json:"version"`
	DocumentHash string          `json:"documentHash"`
	Deleted      bool            `json:"deleted"`
	DeletedAt    *string         `json:"deletedAt"`
	CreatedAt    string          `json:"createdAt"`
	UpdatedAt    string          `json:"updatedAt"`
	Document     json.RawMessage `json:"document"`
}

// Session 是一次登录得到的凭据。
type Session struct {
	ServerURL    string
	AccessToken  string
	RefreshToken string
	UserUID      string
	UserEmail    string
	// Role 是云端账号的角色（admin/user）。桌面端菜单用「网站设置」入口的
	// 显隐就靠它：只有远程管理员才看得到。
	Role string
	// Nickname 是云端账号的昵称（/auth/me 拿到的），顶栏显示用。
	Nickname string
	// TwoFactorChallenge 非空表示账号开了两步验证：密码已通过，还差一次
	// 动态码。此时没有任何令牌，调用方要拿它去 CompleteTwoFactor。
	TwoFactorChallenge string
}

// Client 访问一个云端服务器。
//
// 并发安全：内部有互斥锁保护令牌，因为后台同步与前台请求会同时用到它。
type Client struct {
	baseURL string
	http    *http.Client

	mu      sync.RWMutex
	session Session
	// refreshMu 串行化令牌刷新：并发请求同时 401 时只刷新一次。
	refreshMu sync.Mutex
}

// New 构造客户端。serverURL 允许带尾部斜杠，也允许用户只填域名。
func New(serverURL string, session Session) (*Client, error) {
	base, err := normalizeBaseURL(serverURL)
	if err != nil {
		return nil, err
	}
	session.ServerURL = base
	return &Client{
		baseURL: base,
		http:    &http.Client{Timeout: 30 * time.Second},
		session: session,
	}, nil
}

// Session 返回当前凭据的快照。
func (c *Client) Session() Session {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.session
}

// SetTokens 更新内存里的令牌（刷新之后调用）。
func (c *Client) SetTokens(access, refresh string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if access != "" {
		c.session.AccessToken = access
	}
	if refresh != "" {
		c.session.RefreshToken = refresh
	}
}

func normalizeBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("cloud: server address is required")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("cloud: invalid server address: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("cloud: server address must be http or https")
	}
	if parsed.Host == "" {
		return "", errors.New("cloud: server address has no host")
	}
	// 只保留 scheme + host + 可选路径前缀：用户常常把「/」或者整条登录页
	// 地址粘进来，拼接口时就会多出 /login/api/v1/... 这种路径。
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.User = nil
	base := strings.TrimRight(parsed.String(), "/")
	return base, nil
}

// Login 用账号密码登录云端，返回会话。
func Login(ctx context.Context, serverURL, identifier, password string) (*Client, error) {
	client, err := New(serverURL, Session{})
	if err != nil {
		return nil, err
	}
	challenge, err := client.requestLoginChallenge(ctx, identifier)
	if err != nil {
		return nil, err
	}
	encrypted, err := encryptPassword(challenge, password)
	if err != nil {
		return nil, err
	}
	var result loginResult
	status, details, err := client.do(ctx, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"identifier":        identifier,
		"challengeId":       challenge.ChallengeID,
		"encryptedPassword": encrypted,
	}, &result, false)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, ErrUnauthorized
	}
	if status != http.StatusOK {
		// 带上地址、状态码与服务端错误码：404 多半是地址/路径不对，403 常见于
		// WAF 拦截，5xx 是服务端问题——三种情况处理方式完全不同。
		detail := ""
		if details.Code != "" {
			detail = "（" + details.Code + "）"
		}
		return nil, fmt.Errorf("登录失败：%s 返回 HTTP %d%s", client.baseURL+"/api/v1/auth/login", status, detail)
	}
	if result.TwoFactorRequired || result.ChallengeToken != "" {
		client.mu.Lock()
		client.session.TwoFactorChallenge = result.ChallengeToken
		client.mu.Unlock()
		return client, nil
	}
	client.SetTokens(result.AccessToken, result.RefreshToken)
	if result.User.UID != "" {
		client.mu.Lock()
		client.session.UserUID = result.User.UID
		client.session.UserEmail = result.User.Email
		client.session.Role = result.User.Role
		client.mu.Unlock()
	}
	return client, nil
}

type loginChallenge struct {
	ChallengeID string          `json:"challengeId"`
	PublicKey   json.RawMessage `json:"publicKey"`
	ExpiresIn   int             `json:"expiresIn"`
}

type loginResult struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	// 开了两步验证时服务端只给挑战令牌，不发会话。
	TwoFactorRequired bool   `json:"twoFactorRequired"`
	ChallengeToken    string `json:"challengeToken"`
	ExpiresIn         int    `json:"expiresIn"`
	User              struct {
		UID   string `json:"uid"`
		Email string `json:"email"`
		Role  string `json:"role"`
	} `json:"user"`
}

func (c *Client) requestLoginChallenge(ctx context.Context, identifier string) (*loginChallenge, error) {
	var challenge loginChallenge
	status, details, err := c.do(ctx, http.MethodPost, "/api/v1/auth/login/challenge", map[string]string{
		"identifier": identifier,
	}, &challenge, false)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		detail := ""
		if details.Code != "" {
			detail = "（" + details.Code + "）"
		}
		// 地址写错、反向代理没转发 /api、或服务端版本过老，都会停在这一步。
		return nil, fmt.Errorf("连接服务器失败：%s 返回 HTTP %d%s", c.baseURL+"/api/v1/auth/login/challenge", status, detail)
	}
	if challenge.ChallengeID == "" || len(challenge.PublicKey) == 0 {
		return nil, errors.New("cloud: server returned an unusable login challenge")
	}
	return &challenge, nil
}

// encryptPassword 用挑战里的公钥加密密码。
//
// label 必须与服务端一致（`wmind/login/v1:<challengeId>`），它把密文绑到这次
// 挑战上：换一个挑战就不能复用同一段密文。
func encryptPassword(challenge *loginChallenge, password string) (string, error) {
	var jwk struct {
		Kty string `json:"kty"`
		Alg string `json:"alg"`
		N   string `json:"n"`
		E   string `json:"e"`
	}
	if err := json.Unmarshal(challenge.PublicKey, &jwk); err != nil {
		return "", fmt.Errorf("cloud: parse login public key: %w", err)
	}
	if jwk.Kty != "RSA" || jwk.Alg != "RSA-OAEP-256" {
		return "", errors.New("cloud: server public key is not RSA-OAEP-256")
	}
	modulus, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		return "", fmt.Errorf("cloud: decode modulus: %w", err)
	}
	exponent, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		return "", fmt.Errorf("cloud: decode exponent: %w", err)
	}
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: int(new(big.Int).SetBytes(exponent).Int64())}
	label := []byte("wmind/login/v1:" + challenge.ChallengeID)
	cipher, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, []byte(password), label)
	if err != nil {
		return "", fmt.Errorf("cloud: encrypt password: %w", err)
	}
	return base64.StdEncoding.EncodeToString(cipher), nil
}

// CompleteTwoFactor 用动态码（或恢复码）完成两步验证登录。
func (c *Client) CompleteTwoFactor(ctx context.Context, code string) error {
	session := c.Session()
	if session.TwoFactorChallenge == "" {
		return errors.New("cloud: no two-factor challenge in progress")
	}
	var result loginResult
	status, details, err := c.do(ctx, http.MethodPost, "/api/v1/auth/2fa/verify", map[string]string{
		"challengeToken": session.TwoFactorChallenge,
		"code":           code,
	}, &result, false)
	if err != nil {
		return err
	}
	switch status {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrUnauthorized
	default:
		return fmt.Errorf("cloud: two-factor verification failed with status %d (%s)", status, details.Code)
	}
	c.mu.Lock()
	c.session.TwoFactorChallenge = ""
	c.session.AccessToken = result.AccessToken
	c.session.RefreshToken = result.RefreshToken
	c.session.UserUID = result.User.UID
	c.session.UserEmail = result.User.Email
	c.session.Role = result.User.Role
	c.mu.Unlock()
	return nil
}

// Profile 是远端账号的公开资料。
type Profile struct {
	UID       string `json:"uid"`
	Username  string `json:"username"`
	Email     string `json:"email"`
	Nickname  string `json:"nickname"`
	Role      string `json:"role"`
	AvatarURL string `json:"avatarUrl"`
}

// Me 读取远端账号资料，用于顶栏显示登录后的名字。
//
// 失败不致命：拿不到昵称就退回邮箱，连接本身仍然有效。
func (c *Client) Me(ctx context.Context) (*Profile, error) {
	var profile Profile
	status, details, err := c.do(ctx, http.MethodGet, "/api/v1/auth/me", nil, &profile, true)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("cloud: profile failed with status %d (%s)", status, details.Code)
	}
	c.mu.Lock()
	if profile.Nickname != "" {
		c.session.Nickname = profile.Nickname
	}
	if profile.Email != "" {
		c.session.UserEmail = profile.Email
	}
	if profile.Role != "" {
		c.session.Role = profile.Role
	}
	c.mu.Unlock()
	return &profile, nil
}

// Refresh 用 refresh cookie 换一个新的访问令牌。
func (c *Client) Refresh(ctx context.Context) error {
	// 并发请求同时收到 401 时只刷新一次：用互斥锁串行化，后来者直接复用
	// 已经换好的令牌（刷新令牌是一次性轮换的，重复刷新会互相作废）。
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()

	var result loginResult
	status, _, err := c.send(ctx, http.MethodPost, "/api/v1/auth/refresh", nil, &result, true)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return ErrUnauthorized
	}
	if status != http.StatusOK {
		return fmt.Errorf("cloud: refresh failed with status %d", status)
	}
	c.SetTokens(result.AccessToken, result.RefreshToken)
	return nil
}

// ListChanged 拉取 since 之后有变化的导图（含云端回收站里的）。
func (c *Client) ListChanged(ctx context.Context, since time.Time) ([]*Map, error) {
	path := "/api/v1/maps?updated_since=" + url.QueryEscape(since.UTC().Format(time.RFC3339Nano))
	var maps []*Map
	status, _, err := c.do(ctx, http.MethodGet, path, nil, &maps, true)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("cloud: list changed failed with status %d", status)
	}
	return maps, nil
}

// GetMap 读取云端导图（含完整文档）。
func (c *Client) GetMap(ctx context.Context, uid string) (*Map, error) {
	var found Map
	status, _, err := c.do(ctx, http.MethodGet, "/api/v1/maps/"+url.PathEscape(uid), nil, &found, true)
	if err != nil {
		return nil, err
	}
	switch status {
	case http.StatusOK:
		return &found, nil
	case http.StatusNotFound:
		return nil, ErrMapNotFound
	default:
		return nil, fmt.Errorf("cloud: get map failed with status %d", status)
	}
}

// ErrMapNotFound 表示云端没有这张导图（被彻底删除了）。
var ErrMapNotFound = errors.New("cloud: map not found")

// Upload 把本地导图上传为云端导图，沿用本地 uid（重复上传是幂等的）。
func (c *Client) Upload(ctx context.Context, uid, title string, document json.RawMessage) (*Map, error) {
	body := map[string]any{"uid": uid, "title": title, "document": document}
	var created Map
	status, _, err := c.do(ctx, http.MethodPost, "/api/v1/maps", body, &created, true)
	if err != nil {
		return nil, err
	}
	switch status {
	case http.StatusCreated, http.StatusOK:
		return &created, nil
	case http.StatusConflict:
		return nil, ErrUIDConflict
	default:
		return nil, fmt.Errorf("cloud: upload failed with status %d", status)
	}
}

// ErrUIDConflict 表示云端已有同 uid 的导图（可能在回收站里）。
var ErrUIDConflict = errors.New("cloud: uid already used")

// Save 按版本号保存云端导图。版本冲突返回 *ConflictError。
func (c *Client) Save(ctx context.Context, uid string, version int, title string, document json.RawMessage) (*Map, error) {
	body := map[string]any{"version": version, "title": title, "document": document}
	var saved Map
	status, details, err := c.do(ctx, http.MethodPut, "/api/v1/maps/"+url.PathEscape(uid), body, &saved, true)
	if err != nil {
		return nil, err
	}
	switch status {
	case http.StatusOK:
		return &saved, nil
	case http.StatusNotFound:
		return nil, ErrMapNotFound
	case http.StatusConflict:
		return nil, &ConflictError{
			CurrentVersion:   details.CurrentVersion,
			CurrentHash:      details.CurrentHash,
			CurrentUpdatedAt: details.CurrentUpdatedAt,
		}
	default:
		return nil, fmt.Errorf("cloud: save failed with status %d", status)
	}
}

// Delete 把云端导图移入回收站。
func (c *Client) Delete(ctx context.Context, uid string) error {
	status, _, err := c.do(ctx, http.MethodDelete, "/api/v1/maps/"+url.PathEscape(uid), nil, nil, true)
	if err != nil {
		return err
	}
	switch status {
	case http.StatusNoContent, http.StatusOK:
		return nil
	case http.StatusNotFound:
		return ErrMapNotFound
	default:
		return fmt.Errorf("cloud: delete failed with status %d", status)
	}
}

// envelope 是所有接口的统一信封：成功时 data 有值，失败时 error.details 有值。
type envelope struct {
	Data  json.RawMessage `json:"data"`
	Error struct {
		Code    string `json:"code"`
		Details struct {
			CurrentVersion   int    `json:"currentVersion"`
			CurrentHash      string `json:"currentHash"`
			CurrentUpdatedAt string `json:"currentUpdatedAt"`
		} `json:"details"`
	} `json:"error"`
}

// errorDetails 是失败响应里客户端真正用得到的部分。
type errorDetails struct {
	Code             string
	CurrentVersion   int
	CurrentHash      string
	CurrentUpdatedAt string
}

// do 发一次请求。withAuth 为 true 时带上 Bearer 令牌与 refresh cookie。
//
// 不自动重试：调用方（同步引擎）比这里更清楚「值不值得再试一次」。
// do 发一次请求；带鉴权且收到 401 时刷新令牌并重试一次。
//
// 桌面端是长期运行的：访问令牌十几分钟就过期，服务端换 JWT 密钥也会让旧令牌
// 立刻失效。没有这层重试，用户会在「用着用着同步失败」和「重启才好」之间反复，
// 而实际上刷新令牌一直有效、续期是无感的。
func (c *Client) do(ctx context.Context, method, path string, body, out any, withAuth bool) (int, errorDetails, error) {
	status, details, err := c.send(ctx, method, path, body, out, withAuth)
	// send 把 401 表示成 ErrUnauthorized，所以这里不能只看 err != nil。
	if status != http.StatusUnauthorized || !withAuth {
		return status, details, err
	}
	if err != nil && !errors.Is(err, ErrUnauthorized) {
		return status, details, err
	}
	if refreshErr := c.Refresh(ctx); refreshErr != nil {
		// 刷新也失败（刷新令牌过期/被撤销）：把原来的 401 交给上层，
		// 由它提示用户重新登录。
		return status, details, err
	}
	return c.send(ctx, method, path, body, out, withAuth)
}

func (c *Client) send(ctx context.Context, method, path string, body, out any, withAuth bool) (int, errorDetails, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, errorDetails{}, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return 0, errorDetails{}, err
	}
	// 明确的 UA：默认的 `Go-http-client/1.1` 会被部分 WAF 直接拦掉（浏览器能开、
	// 客户端打不开就是这类原因）。
	req.Header.Set("User-Agent", "WmindDesktop")
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if withAuth {
		session := c.Session()
		if session.AccessToken != "" {
			req.Header.Set("Authorization", "Bearer "+session.AccessToken)
		}
		if session.RefreshToken != "" {
			req.AddCookie(&http.Cookie{Name: "wmind_refresh", Value: session.RefreshToken, Path: "/api/v1/auth"})
		}
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return 0, errorDetails{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return 0, errorDetails{}, fmt.Errorf("%w: read body: %v", ErrUnavailable, err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return resp.StatusCode, errorDetails{}, ErrUnauthorized
	}
	if len(raw) == 0 {
		return resp.StatusCode, errorDetails{}, nil
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return resp.StatusCode, errorDetails{}, fmt.Errorf("%w: unexpected body: %v", ErrUnavailable, err)
	}
	details := errorDetails{
		Code:             env.Error.Code,
		CurrentVersion:   env.Error.Details.CurrentVersion,
		CurrentHash:      env.Error.Details.CurrentHash,
		CurrentUpdatedAt: env.Error.Details.CurrentUpdatedAt,
	}
	if out != nil && len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return resp.StatusCode, details, fmt.Errorf("%w: unexpected body: %v", ErrUnavailable, err)
		}
	}
	return resp.StatusCode, details, nil
}
