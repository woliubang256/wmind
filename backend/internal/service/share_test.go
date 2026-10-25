package service

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// fakeShareRepo 是内存版分享仓储。
//
// 与 fakeMapRepo 同一套路：内嵌 nil 接口，只实现测试真正走到的方法，
// 其余被调用即 panic。
type fakeShareRepo struct {
	domain.ShareRepo

	mu     sync.Mutex
	nextID int64
	rows   []*domain.ShareLink

	// documents 按 mapID 存文档，供 GetByToken 使用。
	documents map[int64][]byte
	// deletedMaps 标记哪些 mapID 在回收站里。
	deletedMaps map[int64]bool
	// nickname 是 GetByToken 返回的分享者昵称。
	nickname string
	// viewWrites 统计 RecordView 实际被调用的次数。
	viewWrites int
	// mapMeta 记录 mapID → (uid, title)，用来模拟真实查询里的 JOIN：
	// 真实仓储的每条读查询都 JOIN maps，克隆时不补这两个字段会让
	// 「改写后导图信息丢失」这类真实缺陷在测试里变成假绿。
	mapMeta map[int64]mapMeta
}

// mapMeta 是导图的对外标识，只用于填充 JOIN 字段。
type mapMeta struct {
	UID   string
	Title string
}

func newFakeShareRepo() *fakeShareRepo {
	return &fakeShareRepo{
		documents:   make(map[int64][]byte),
		deletedMaps: make(map[int64]bool),
		mapMeta:     make(map[int64]mapMeta),
	}
}

func (r *fakeShareRepo) clone(link *domain.ShareLink) *domain.ShareLink {
	copied := *link
	if meta, ok := r.mapMeta[link.MapID]; ok {
		copied.MapUID = meta.UID
		copied.MapTitle = meta.Title
	}
	return &copied
}

func (r *fakeShareRepo) find(uid string, ownerID int64) *domain.ShareLink {
	for _, row := range r.rows {
		if row.UID == uid && row.OwnerID == ownerID {
			return row
		}
	}
	return nil
}

func (r *fakeShareRepo) Create(_ context.Context, in domain.CreateShareInput) (*domain.ShareLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	link := &domain.ShareLink{
		ID: r.nextID, UID: in.UID, Token: in.Token, MapID: in.MapID, OwnerID: in.OwnerID,
		PasswordHash: in.PasswordHash, AllowDownload: in.AllowDownload, ShowNotes: in.ShowNotes,
		PasswordCiphertext: in.PasswordCiphertext,
		ExpiresAt:          in.ExpiresAt, CreatedAt: in.Now,
	}
	r.rows = append(r.rows, link)
	return r.clone(link), nil
}

func (r *fakeShareRepo) GetByUID(_ context.Context, uid string, ownerID int64) (*domain.ShareLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID)
	if row == nil {
		return nil, domain.ErrNotFound
	}
	return r.clone(row), nil
}

func (r *fakeShareRepo) GetByToken(_ context.Context, token string) (*domain.ShareDocument, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, row := range r.rows {
		if row.Token != token {
			continue
		}
		return &domain.ShareDocument{
			Share:         r.clone(row),
			Document:      append([]byte(nil), r.documents[row.MapID]...),
			MapDeleted:    r.deletedMaps[row.MapID],
			OwnerNickname: r.nickname,
		}, nil
	}
	return nil, domain.ErrNotFound
}

func (r *fakeShareRepo) ListByMap(_ context.Context, mapID int64, ownerID int64) ([]*domain.ShareLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.ShareLink, 0, len(r.rows))
	for _, row := range r.rows {
		if row.MapID == mapID && row.OwnerID == ownerID {
			out = append(out, r.clone(row))
		}
	}
	return out, nil
}

func (r *fakeShareRepo) ListByOwner(_ context.Context, ownerID int64, _ string, _ domain.Page) ([]*domain.ShareLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.ShareLink, 0, len(r.rows))
	for _, row := range r.rows {
		if row.OwnerID == ownerID {
			out = append(out, r.clone(row))
		}
	}
	return out, nil
}

func (r *fakeShareRepo) CountByOwner(_ context.Context, ownerID int64, _ string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var total int64
	for _, row := range r.rows {
		if row.OwnerID == ownerID {
			total++
		}
	}
	return total, nil
}

func (r *fakeShareRepo) CountActiveByMap(_ context.Context, mapID int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var total int64
	for _, row := range r.rows {
		if row.MapID == mapID && row.RevokedAt == nil {
			total++
		}
	}
	return total, nil
}

func (r *fakeShareRepo) Update(_ context.Context, in domain.UpdateShareInput) (*domain.ShareLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(in.UID, in.OwnerID)
	if row == nil || row.RevokedAt != nil {
		return nil, domain.ErrNotFound
	}
	row.PasswordHash = in.PasswordHash
	row.PasswordCiphertext = in.PasswordCiphertext
	row.AllowDownload = in.AllowDownload
	row.ShowNotes = in.ShowNotes
	row.ExpiresAt = in.ExpiresAt
	return r.clone(row), nil
}

func (r *fakeShareRepo) Revoke(_ context.Context, uid string, ownerID int64, now time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID)
	if row == nil || row.RevokedAt != nil {
		return domain.ErrNotFound
	}
	at := now
	row.RevokedAt = &at
	return nil
}

func (r *fakeShareRepo) RecordView(_ context.Context, id int64, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.viewWrites++
	for _, row := range r.rows {
		if row.ID == id {
			row.ViewCount++
			viewed := at
			row.LastViewedAt = &viewed
		}
	}
	return nil
}

// fakeSharePolicy 是固定值的站点策略。
type fakeSharePolicy struct {
	enabled     bool
	requirePass bool
	maxLinks    int
	baseURL     string
}

func (p fakeSharePolicy) ShareEnabled() bool         { return p.enabled }
func (p fakeSharePolicy) ShareRequirePassword() bool { return p.requirePass }
func (p fakeSharePolicy) ShareMaxLinksPerMap() int   { return p.maxLinks }
func (p fakeSharePolicy) SiteBaseURL() string        { return p.baseURL }

func defaultSharePolicy() fakeSharePolicy {
	return fakeSharePolicy{enabled: true, maxLinks: DefaultMaxLinksPerMap}
}

// shareFixture 是一套装配好的分享服务 + 它依赖的假仓储。
type shareFixture struct {
	svc    *ShareService
	shares *fakeShareRepo
	maps   *fakeMapRepo
	clock  *testClock
}

// testClock 是可控时钟。
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock(at time.Time) *testClock { return &testClock{now: at} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newShareFixture(t *testing.T, policy SharePolicy) *shareFixture {
	t.Helper()
	clock := newTestClock(time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC))
	shares := newFakeShareRepo()
	maps := newFakeMapRepo()
	tokens, err := auth.NewShareTokenIssuer("share-test-secret-that-is-long-enough", 30*time.Minute)
	if err != nil {
		t.Fatalf("NewShareTokenIssuer: %v", err)
	}
	passwords, err := auth.NewSharePasswordCipher("share-test-secret-that-is-long-enough")
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewShareService(ShareServiceConfig{
		Shares: shares, Maps: maps, Policy: policy, Tokens: tokens,
		Passwords: passwords,
		Views:     NewViewDeduper(DefaultShareViewWindow, clock.Now),
		Now:       clock.Now,
	})
	if err != nil {
		t.Fatalf("NewShareService: %v", err)
	}
	return &shareFixture{svc: svc, shares: shares, maps: maps, clock: clock}
}

// seedMap 建一张导图（带文档），返回它的 uid 与内部 ID。
func (f *shareFixture) seedMap(t *testing.T, ownerID int64, title string) (string, int64) {
	t.Helper()
	doc := validDoc(t, title)
	created, err := f.maps.Create(context.Background(), domain.CreateMapInput{
		UID: "map-" + title, OwnerID: ownerID, Title: title, Document: doc,
		NodeCount: 3, SizeBytes: int64(len(doc)), Now: f.clock.Now(),
	})
	if err != nil {
		t.Fatalf("建导图: %v", err)
	}
	f.shares.documents[created.ID] = doc
	f.shares.mapMeta[created.ID] = mapMeta{UID: created.UID, Title: created.Title}
	return created.UID, created.ID
}

func TestShareCreateDisabledSite(t *testing.T) {
	policy := defaultSharePolicy()
	policy.enabled = false
	f := newShareFixture(t, policy)
	mapUID, _ := f.seedMap(t, 1, "产品规划")

	_, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{AllowDownload: true, ShowNotes: true})
	if code := codeOf(t, err); code != apperr.CodeShareDisabled {
		t.Fatalf("code = %s，期望 %s", code, apperr.CodeShareDisabled)
	}
}

func TestShareCreateRejectsUnknownMap(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())

	_, err := f.svc.Create(context.Background(), "nope", 1, CreateShareInput{})
	if code := codeOf(t, err); code != apperr.CodeMapNotFound {
		t.Fatalf("code = %s，期望 %s", code, apperr.CodeMapNotFound)
	}
}

func TestShareCreateRequiresPasswordWhenSiteDemandsIt(t *testing.T) {
	policy := defaultSharePolicy()
	policy.requirePass = true
	f := newShareFixture(t, policy)
	mapUID, _ := f.seedMap(t, 1, "产品规划")

	_, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
	appErr := apperr.From(err)
	if appErr == nil || appErr.Code != apperr.CodeValidationFailed {
		t.Fatalf("err = %v，期望 VALIDATION_FAILED", err)
	}
	if _, ok := appErr.Details["fields"].(map[string]string)["password"]; !ok {
		t.Fatalf("details 里应有 fields.password，实际 %#v", appErr.Details)
	}
}

func TestShareCreateRejectsShortPassword(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")

	_, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{Password: "123"})
	if code := codeOf(t, err); code != apperr.CodeValidationFailed {
		t.Fatalf("code = %s，期望 %s", code, apperr.CodeValidationFailed)
	}
}

func TestShareCreateEnforcesLinkLimit(t *testing.T) {
	policy := defaultSharePolicy()
	policy.maxLinks = 2
	f := newShareFixture(t, policy)
	mapUID, _ := f.seedMap(t, 1, "产品规划")

	for i := 0; i < 2; i++ {
		if _, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{AllowDownload: true}); err != nil {
			t.Fatalf("第 %d 次创建: %v", i+1, err)
		}
	}
	_, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
	if code := codeOf(t, err); code != apperr.CodeShareLimitReached {
		t.Fatalf("code = %s，期望 %s", code, apperr.CodeShareLimitReached)
	}
}

func TestShareCreateExpiryAndURL(t *testing.T) {
	policy := defaultSharePolicy()
	policy.baseURL = "https://wmind.example.com/"
	f := newShareFixture(t, policy)
	mapUID, _ := f.seedMap(t, 1, "产品规划")

	// 永久：expiresAt 为 nil。
	forever, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{AllowDownload: true})
	if err != nil {
		t.Fatalf("创建永久链接: %v", err)
	}
	if forever.ExpiresAt != nil {
		t.Fatalf("expiresAt = %v，期望 nil", forever.ExpiresAt)
	}
	// 尾部斜杠被吃掉，不会出现双斜杠。
	wantURL := "https://wmind.example.com/s/" + forever.Token
	if got := f.svc.ShareURL(forever.Token); got != wantURL {
		t.Fatalf("ShareURL = %q，期望 %q", got, wantURL)
	}

	// 7 天。
	week, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{ExpiresInDays: 7})
	if err != nil {
		t.Fatalf("创建 7 天链接: %v", err)
	}
	if week.ExpiresAt == nil {
		t.Fatal("expiresAt 为 nil，期望 7 天后")
	}
	if got := week.ExpiresAt.Sub(f.clock.Now()); got != 7*24*time.Hour {
		t.Fatalf("有效期 = %v，期望 168h", got)
	}

	// 越界。
	if _, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{ExpiresInDays: 4000}); codeOf(t, err) != apperr.CodeValidationFailed {
		t.Fatalf("4000 天应被拒，实际 %v", err)
	}
	if _, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{ExpiresInDays: -1}); codeOf(t, err) != apperr.CodeValidationFailed {
		t.Fatalf("负天数应被拒，实际 %v", err)
	}
}

func TestShareTokenIsURLSafeAndUnique(t *testing.T) {
	// 上限放到 100，否则 50 次创建会在第 21 次撞上 SHARE_LIMIT_REACHED
	// ——那测的是配额，不是令牌。
	policy := defaultSharePolicy()
	policy.maxLinks = 100
	f := newShareFixture(t, policy)
	mapUID, _ := f.seedMap(t, 1, "产品规划")

	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		link, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
		if err != nil {
			t.Fatalf("创建: %v", err)
		}
		// 16 字节 base64url 无填充 = 22 字符。
		if len(link.Token) != 22 {
			t.Fatalf("token = %q（%d 字符），期望 22", link.Token, len(link.Token))
		}
		if strings.ContainsAny(link.Token, "+/=") {
			t.Fatalf("token %q 含非 base64url 字符", link.Token)
		}
		if seen[link.Token] {
			t.Fatalf("token %q 重复", link.Token)
		}
		seen[link.Token] = true
	}
}

func TestShareUpdateMergesOnlyProvidedFields(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")
	created, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{
		Password: "abcd", ExpiresInDays: 7, AllowDownload: true, ShowNotes: true,
	})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}

	// 只关掉「允许下载」：密码与有效期必须原样保留。
	allow := false
	updated, err := f.svc.Update(context.Background(), created.UID, 1, UpdateShareInput{AllowDownload: &allow})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.AllowDownload {
		t.Fatal("allowDownload 仍为 true")
	}
	if !updated.HasPassword() {
		t.Fatal("密码被顺手清掉了")
	}
	if updated.ExpiresAt == nil || !updated.ExpiresAt.Equal(*created.ExpiresAt) {
		t.Fatalf("expiresAt 变了：%v → %v", created.ExpiresAt, updated.ExpiresAt)
	}
	// RETURNING 没有 JOIN，服务层要从读出来的那一行补上导图信息。
	if updated.MapUID != mapUID || updated.MapTitle != "产品规划" {
		t.Fatalf("导图信息丢失：uid=%q title=%q", updated.MapUID, updated.MapTitle)
	}

	// 显式传空串 = 清除密码。
	empty := ""
	cleared, err := f.svc.Update(context.Background(), created.UID, 1, UpdateShareInput{Password: &empty})
	if err != nil {
		t.Fatalf("清密码: %v", err)
	}
	if cleared.HasPassword() {
		t.Fatal("密码未被清除")
	}

	// 显式传 0 = 改为永久。
	zero := 0
	forever, err := f.svc.Update(context.Background(), created.UID, 1, UpdateShareInput{ExpiresInDays: &zero})
	if err != nil {
		t.Fatalf("改永久: %v", err)
	}
	if forever.ExpiresAt != nil {
		t.Fatalf("expiresAt = %v，期望 nil", forever.ExpiresAt)
	}
}

func TestShareUpdateRejectsRevokedLink(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")
	created, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	if err := f.svc.Revoke(context.Background(), created.UID, 1); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	allow := true
	_, err = f.svc.Update(context.Background(), created.UID, 1, UpdateShareInput{AllowDownload: &allow})
	if code := codeOf(t, err); code != apperr.CodeShareNotFound {
		t.Fatalf("code = %s，期望 %s", code, apperr.CodeShareNotFound)
	}
	// 二次撤销也是 404：调用方不该以为「刚刚撤销成功」。
	if err := f.svc.Revoke(context.Background(), created.UID, 1); codeOf(t, err) != apperr.CodeShareNotFound {
		t.Fatalf("二次撤销 = %v，期望 SHARE_NOT_FOUND", err)
	}
}

func TestShareOwnerLegacyPasswordRecovery(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	ctx := context.Background()
	mapUID, _ := f.seedMap(t, 1, "密码")
	created, err := f.svc.Create(ctx, mapUID, 1, CreateShareInput{Password: " Ab9x "})
	if err != nil {
		t.Fatal(err)
	}
	stored := f.shares.rows[0]
	if stored.Password != nil || stored.PasswordCiphertext != "plain:Ab9x" || !auth.VerifyPassword(stored.PasswordHash, "Ab9x") {
		t.Fatal("repository must store a tagged readable value and an independent bcrypt hash")
	}
	if created.Password == nil || *created.Password != "Ab9x" {
		t.Fatal("owner create password missing")
	}
	// Seed the actual legacy format, not a value produced by the new write path.
	ciphertext, err := f.svc.passwords.Encrypt("Ab9x", created.UID, 1)
	if err != nil {
		t.Fatal(err)
	}
	stored.PasswordCiphertext = ciphertext
	notes := true
	updated, err := f.svc.Update(ctx, created.UID, 1, UpdateShareInput{ShowNotes: &notes})
	if err != nil || updated.PasswordCiphertext != ciphertext || updated.Password == nil || *updated.Password != "Ab9x" {
		t.Fatalf("unrelated patch changed password: %v", err)
	}
	if _, err := f.svc.Update(ctx, created.UID, 2, UpdateShareInput{}); codeOf(t, err) != apperr.CodeShareNotFound {
		t.Fatal("cross-owner access allowed")
	}
	for _, tc := range []string{"legacy", "corrupt", "unknown-format", "empty-plain", "wrong-key"} {
		t.Run(tc, func(t *testing.T) {
			stored.PasswordCiphertext = ciphertext
			switch tc {
			case "legacy":
				stored.PasswordCiphertext = ""
			case "corrupt":
				stored.PasswordCiphertext = "invalid"
			case "unknown-format":
				stored.PasswordCiphertext = "v2:unknown"
			case "empty-plain":
				stored.PasswordCiphertext = "plain:"
			case "wrong-key":
				f.svc.passwords, _ = auth.NewSharePasswordCipher(strings.Repeat("x", 32))
			}
			list, err := f.svc.ListByMap(ctx, mapUID, 1)
			if err != nil || len(list) != 1 || list[0].Password != nil || !list[0].HasPassword() {
				t.Fatalf("unavailable ciphertext must not remove protection: %v", err)
			}
			mine, _, err := f.svc.ListMine(ctx, 1, "", 1, 20)
			if err != nil || mine[0].Password != nil {
				t.Fatalf("list mine: %v", err)
			}
			if _, _, err := f.svc.VerifyPassword(ctx, created.Token, "Ab9x"); err != nil {
				t.Fatalf("bcrypt must remain usable: %v", err)
			}
			if _, err := f.svc.ReadPublic(ctx, created.Token, "", "127.0.0.1"); codeOf(t, err) != apperr.CodeSharePasswordRequired {
				t.Fatal("public gate bypassed")
			}
			next := "Cd8y"
			reset, err := f.svc.Update(ctx, created.UID, 1, UpdateShareInput{Password: &next})
			if err != nil || reset.Password == nil || *reset.Password != next || stored.PasswordCiphertext != "plain:"+next {
				t.Fatalf("reset unavailable password: %v", err)
			}
			if _, _, err := f.svc.VerifyPassword(ctx, created.Token, next); err != nil {
				t.Fatalf("reset verification: %v", err)
			}
			// Restore the old hash for the next independent recovery case.
			stored.PasswordHash = created.PasswordHash
		})
	}
	empty := ""
	cleared, err := f.svc.Update(ctx, created.UID, 1, UpdateShareInput{Password: &empty})
	if err != nil || cleared.Password != nil || cleared.PasswordCiphertext != "" || cleared.HasPassword() {
		t.Fatalf("clear must erase both forms: %v", err)
	}
}

func TestSharePublicFourInvalidStatesLookIdentical(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, mapID := f.seedMap(t, 1, "产品规划")

	// 1) 令牌不存在。
	if _, err := f.svc.ReadPublic(context.Background(), "no-such-token", "", "1.2.3.4"); codeOf(t, err) != apperr.CodeShareNotFound {
		t.Fatalf("不存在的令牌 = %v，期望 SHARE_NOT_FOUND", err)
	}

	// 2) 已撤销。
	revoked, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	if err := f.svc.Revoke(context.Background(), revoked.UID, 1); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, err := f.svc.ReadPublic(context.Background(), revoked.Token, "", "1.2.3.4"); codeOf(t, err) != apperr.CodeShareNotFound {
		t.Fatalf("已撤销 = %v，期望 SHARE_NOT_FOUND", err)
	}

	// 3) 已过期。
	expiring, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{ExpiresInDays: 1})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	f.clock.Advance(48 * time.Hour)
	if _, err := f.svc.ReadPublic(context.Background(), expiring.Token, "", "1.2.3.4"); codeOf(t, err) != apperr.CodeShareNotFound {
		t.Fatalf("已过期 = %v，期望 SHARE_NOT_FOUND", err)
	}

	// 4) 导图已删除（软删除）。
	alive, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	f.shares.deletedMaps[mapID] = true
	if _, err := f.svc.ReadPublic(context.Background(), alive.Token, "", "1.2.3.4"); codeOf(t, err) != apperr.CodeShareNotFound {
		t.Fatalf("导图已删除 = %v，期望 SHARE_NOT_FOUND", err)
	}
}

func TestSharePublicPasswordGate(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")
	link, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{Password: "abcd", ShowNotes: true})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}

	// 没带凭证 → 401 SHARE_PASSWORD_REQUIRED。
	if _, err := f.svc.ReadPublic(context.Background(), link.Token, "", "1.2.3.4"); codeOf(t, err) != apperr.CodeSharePasswordRequired {
		t.Fatalf("无凭证 = %v，期望 SHARE_PASSWORD_REQUIRED", err)
	}
	// 错密码 → SHARE_PASSWORD_INVALID。
	if _, _, err := f.svc.VerifyPassword(context.Background(), link.Token, "wrong"); codeOf(t, err) != apperr.CodeSharePasswordInvalid {
		t.Fatalf("错密码 = %v，期望 SHARE_PASSWORD_INVALID", err)
	}
	// 对密码 → 拿到凭证，且凭证能换到内容。
	access, expiresIn, err := f.svc.VerifyPassword(context.Background(), link.Token, "abcd")
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if expiresIn != 1800 {
		t.Fatalf("expiresIn = %d，期望 1800", expiresIn)
	}
	payload, err := f.svc.ReadPublic(context.Background(), link.Token, access, "1.2.3.4")
	if err != nil {
		t.Fatalf("带凭证读取: %v", err)
	}
	if payload.Title != "产品规划" {
		t.Fatalf("title = %q", payload.Title)
	}
}

func TestShareAccessTokenIsBoundToItsShare(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")
	first, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{Password: "abcd"})
	if err != nil {
		t.Fatalf("创建第一条: %v", err)
	}
	second, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{Password: "efgh"})
	if err != nil {
		t.Fatalf("创建第二条: %v", err)
	}
	access, _, err := f.svc.VerifyPassword(context.Background(), first.Token, "abcd")
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	// 把第一条的凭证用到第二条上必须失败：否则「知道任意一条链接的密码」
	// 就等于「知道所有链接的密码」。
	if _, err := f.svc.ReadPublic(context.Background(), second.Token, access, "1.2.3.4"); codeOf(t, err) != apperr.CodeSharePasswordRequired {
		t.Fatalf("跨分享用凭证 = %v，期望 SHARE_PASSWORD_REQUIRED", err)
	}
}

func TestShareVerifyOnPasswordlessLinkIsRejected(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")
	link, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	if _, _, err := f.svc.VerifyPassword(context.Background(), link.Token, "anything"); codeOf(t, err) != apperr.CodeValidationFailed {
		t.Fatalf("无密码链接调用 verify = %v，期望 VALIDATION_FAILED", err)
	}
}

func TestSharePublicStripsNotesServerSide(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, mapID := f.seedMap(t, 1, "产品规划")

	// 造一份带备注与扩展字段的文档。
	doc := map[string]any{
		"format": "wmind", "formatVersion": "1.0", "id": "doc-1", "title": "产品规划",
		"meta":       map[string]any{"app": "wmind/1.0", "createdAt": "2026-10-21T10:00:00Z"},
		"extensions": []any{map[string]any{"secret": "internal"}},
		"sheets": []any{map[string]any{
			"id": "sh-1",
			"rootTopic": map[string]any{
				"id": "root", "title": "中心",
				"notes":      map[string]any{"plain": "这是备注", "html": "<p>这是备注</p>"},
				"extensions": []any{},
				"children": map[string]any{"attached": []any{
					map[string]any{"id": "a", "title": "A", "notes": map[string]any{"plain": "子备注", "html": ""}},
				}},
			},
		}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	f.shares.documents[mapID] = raw

	// showNotes = false：备注在**响应体**里就不存在。
	hidden, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{ShowNotes: false})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	payload, err := f.svc.ReadPublic(context.Background(), hidden.Token, "", "1.2.3.4")
	if err != nil {
		t.Fatalf("ReadPublic: %v", err)
	}
	if strings.Contains(string(payload.Document), "这是备注") || strings.Contains(string(payload.Document), "子备注") {
		t.Fatalf("备注没有被剥离：%s", payload.Document)
	}
	if strings.Contains(string(payload.Document), "internal") {
		t.Fatalf("extensions 没有被剥离：%s", payload.Document)
	}
	if strings.Contains(string(payload.Document), "wmind/1.0") {
		t.Fatalf("meta.app 没有被剥离：%s", payload.Document)
	}

	// showNotes = true：备注保留，但 extensions / meta.app 仍然剥离。
	shown, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{ShowNotes: true})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	payload, err = f.svc.ReadPublic(context.Background(), shown.Token, "", "1.2.3.4")
	if err != nil {
		t.Fatalf("ReadPublic: %v", err)
	}
	if !strings.Contains(string(payload.Document), "这是备注") {
		t.Fatalf("showNotes=true 时备注应当保留：%s", payload.Document)
	}
	if strings.Contains(string(payload.Document), "internal") {
		t.Fatalf("extensions 没有被剥离：%s", payload.Document)
	}
}

func TestShareViewCountDedupedWithinWindow(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")
	link, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{})
	if err != nil {
		t.Fatalf("创建: %v", err)
	}

	for i := 0; i < 3; i++ {
		if _, err := f.svc.ReadPublic(context.Background(), link.Token, "", "9.9.9.9"); err != nil {
			t.Fatalf("第 %d 次读取: %v", i+1, err)
		}
	}
	if f.shares.viewWrites != 1 {
		t.Fatalf("窗口内写了 %d 次计数，期望 1", f.shares.viewWrites)
	}
	// 另一个 IP 是另一个访客。
	if _, err := f.svc.ReadPublic(context.Background(), link.Token, "", "8.8.8.8"); err != nil {
		t.Fatalf("读取: %v", err)
	}
	if f.shares.viewWrites != 2 {
		t.Fatalf("第二个 IP 后写了 %d 次，期望 2", f.shares.viewWrites)
	}
	// 窗口过去之后重新计数。
	f.clock.Advance(DefaultShareViewWindow + time.Minute)
	if _, err := f.svc.ReadPublic(context.Background(), link.Token, "", "9.9.9.9"); err != nil {
		t.Fatalf("读取: %v", err)
	}
	if f.shares.viewWrites != 3 {
		t.Fatalf("窗口过后写了 %d 次，期望 3", f.shares.viewWrites)
	}
}

func TestShareListMineAndByMap(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	mapUID, _ := f.seedMap(t, 1, "产品规划")
	otherUID, _ := f.seedMap(t, 1, "另一张")

	if _, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{}); err != nil {
		t.Fatalf("创建: %v", err)
	}
	if _, err := f.svc.Create(context.Background(), mapUID, 1, CreateShareInput{}); err != nil {
		t.Fatalf("创建: %v", err)
	}
	if _, err := f.svc.Create(context.Background(), otherUID, 1, CreateShareInput{}); err != nil {
		t.Fatalf("创建: %v", err)
	}

	byMap, err := f.svc.ListByMap(context.Background(), mapUID, 1)
	if err != nil {
		t.Fatalf("ListByMap: %v", err)
	}
	if len(byMap) != 2 {
		t.Fatalf("ListByMap = %d 条，期望 2", len(byMap))
	}

	mine, total, err := f.svc.ListMine(context.Background(), 1, "", 1, 20)
	if err != nil {
		t.Fatalf("ListMine: %v", err)
	}
	if len(mine) != 3 || total != 3 {
		t.Fatalf("ListMine = %d/%d，期望 3/3", len(mine), total)
	}

	// 跨用户：别人的导图一律 404。
	if _, err := f.svc.ListByMap(context.Background(), mapUID, 2); codeOf(t, err) != apperr.CodeMapNotFound {
		t.Fatalf("跨用户 ListByMap = %v，期望 MAP_NOT_FOUND", err)
	}
}
