package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// fakeMapRepo 是内存版导图仓储。
//
// 只实现测试真正走到的方法，其余由内嵌的 nil 接口提供——被调用即 panic，
// 比返回零值更能暴露「测试走到了预期之外的分支」。
type fakeMapRepo struct {
	domain.MapRepo

	mu     sync.Mutex
	nextID int64
	rows   []*domain.Map

	// lastPattern 记录搜索时收到的 LIKE 模式，用来断言通配符转义。
	lastPattern string
}

func newFakeMapRepo() *fakeMapRepo { return &fakeMapRepo{} }

func (r *fakeMapRepo) clone(m *domain.Map) *domain.Map {
	copied := *m
	copied.Document = append([]byte(nil), m.Document...)
	return &copied
}

func (r *fakeMapRepo) find(uid string, ownerID int64, includeDeleted bool) *domain.Map {
	for _, row := range r.rows {
		if row.UID != uid || row.OwnerID != ownerID {
			continue
		}
		if !includeDeleted && row.DeletedAt != nil {
			return nil
		}
		return row
	}
	return nil
}

func (r *fakeMapRepo) Create(_ context.Context, in domain.CreateMapInput) (*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	row := &domain.Map{
		ID: r.nextID, UID: in.UID, OwnerID: in.OwnerID, Title: in.Title,
		Document: append([]byte(nil), in.Document...), Version: 1,
		NodeCount: in.NodeCount, SizeBytes: in.SizeBytes,
		CreatedAt: in.Now, UpdatedAt: in.Now,
	}
	r.rows = append(r.rows, row)
	return r.clone(row), nil
}

func (r *fakeMapRepo) GetByUID(_ context.Context, uid string, ownerID int64) (*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID, false)
	if row == nil {
		return nil, domain.ErrNotFound
	}
	return r.clone(row), nil
}

func (r *fakeMapRepo) UpdateWithVersion(_ context.Context, in domain.UpdateMapInput) (*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(in.UID, in.OwnerID, false)
	if row == nil {
		return nil, domain.ErrNotFound
	}
	if row.Version != in.ExpectedVersion {
		return nil, domain.ErrVersionConflict
	}
	row.Title = in.Title
	row.Document = append([]byte(nil), in.Document...)
	row.NodeCount = in.NodeCount
	row.SizeBytes = in.SizeBytes
	row.Version++
	row.UpdatedAt = in.Now
	return r.clone(row), nil
}

func (r *fakeMapRepo) UpdateMeta(_ context.Context, uid string, ownerID int64, title string, now time.Time) (*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID, false)
	if row == nil {
		return nil, domain.ErrNotFound
	}
	row.Title = title
	row.UpdatedAt = now
	return r.clone(row), nil
}

func (r *fakeMapRepo) CountByOwner(_ context.Context, ownerID int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for _, row := range r.rows {
		if row.OwnerID == ownerID && row.DeletedAt == nil {
			count++
		}
	}
	return count, nil
}

func (r *fakeMapRepo) ListByOwner(_ context.Context, ownerID int64, _ domain.Page) ([]*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Map, 0)
	for _, row := range r.rows {
		if row.OwnerID == ownerID && row.DeletedAt == nil {
			out = append(out, r.clone(row))
		}
	}
	return out, nil
}

func (r *fakeMapRepo) SearchByTitle(_ context.Context, ownerID int64, pattern string, _ domain.Page) ([]*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastPattern = pattern
	out := make([]*domain.Map, 0)
	for _, row := range r.rows {
		if row.OwnerID == ownerID && row.DeletedAt == nil {
			out = append(out, r.clone(row))
		}
	}
	return out, nil
}

func (r *fakeMapRepo) CountByTitle(_ context.Context, _ int64, _ string) (int64, error) {
	return 0, nil
}

func (r *fakeMapRepo) SoftDelete(_ context.Context, uid string, ownerID int64, now time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID, false)
	if row == nil {
		return domain.ErrNotFound
	}
	row.DeletedAt = &now
	return nil
}

func (r *fakeMapRepo) Restore(_ context.Context, uid string, ownerID int64, now time.Time) (*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID, true)
	if row == nil || row.DeletedAt == nil {
		return nil, domain.ErrNotFound
	}
	row.DeletedAt = nil
	row.UpdatedAt = now
	return r.clone(row), nil
}

func (r *fakeMapRepo) HardDelete(_ context.Context, uid string, ownerID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, row := range r.rows {
		if row.UID == uid && row.OwnerID == ownerID {
			r.rows = append(r.rows[:i], r.rows[i+1:]...)
			return nil
		}
	}
	return domain.ErrNotFound
}

func (r *fakeMapRepo) ListTrashed(_ context.Context, ownerID int64, _ domain.Page) ([]*domain.Map, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Map, 0)
	for _, row := range r.rows {
		if row.OwnerID == ownerID && row.DeletedAt != nil {
			out = append(out, r.clone(row))
		}
	}
	return out, nil
}

func (r *fakeMapRepo) CountTrashed(_ context.Context, ownerID int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var count int64
	for _, row := range r.rows {
		if row.OwnerID == ownerID && row.DeletedAt != nil {
			count++
		}
	}
	return count, nil
}

func (r *fakeMapRepo) HardDeleteTrashed(_ context.Context, ownerID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.rows[:0]
	for _, row := range r.rows {
		if row.OwnerID != ownerID || row.DeletedAt == nil {
			kept = append(kept, row)
		}
	}
	r.rows = kept
	return nil
}

// fakeLimits 是固定的站点限制。
type fakeLimits struct{ mapsPerUser int }

func (l fakeLimits) MapsPerUser() int { return l.mapsPerUser }

func newMapService(t *testing.T, limits MapLimits) (*MapService, *fakeMapRepo) {
	t.Helper()
	repo := newFakeMapRepo()
	svc, err := NewMapService(MapServiceConfig{
		Maps: repo, Limits: limits, Now: func() time.Time { return time.Unix(1_700_000_000, 0).UTC() },
	})
	if err != nil {
		t.Fatalf("NewMapService: %v", err)
	}
	return svc, repo
}

// validDoc 造一份最小可用的 .wmind 文档，节点数为 1 + 2 = 3。
func validDoc(t *testing.T, title string) []byte {
	t.Helper()
	doc := map[string]any{
		"format": "wmind", "formatVersion": "1.0", "id": "doc-1", "title": title,
		"sheets": []any{map[string]any{
			"id": "sh-1",
			"rootTopic": map[string]any{
				"id": "root", "title": "中心",
				"children": map[string]any{"attached": []any{
					map[string]any{"id": "a", "title": "A"},
					map[string]any{"id": "b", "title": "B"},
				}},
			},
		}},
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func codeOf(t *testing.T, err error) apperr.Code {
	t.Helper()
	appErr := apperr.From(err)
	if appErr == nil {
		t.Fatalf("期望 AppError，实际 %v", err)
	}
	return appErr.Code
}

func TestCreateCountsNodesAndDefaultsTitle(t *testing.T) {
	svc, _ := newMapService(t, nil)

	created, err := svc.Create(context.Background(), 1, CreateMapInput{Title: "  ", Document: validDoc(t, "x")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.Title != domain.DefaultMapTitle {
		t.Errorf("空标题应该回落到默认值，得到 %q", created.Title)
	}
	if created.NodeCount != 3 {
		t.Errorf("节点数 = %d，期望 3", created.NodeCount)
	}
	if created.Version != 1 {
		t.Errorf("新导图版本应为 1，得到 %d", created.Version)
	}
}

func TestCreateRejectsInvalidDocuments(t *testing.T) {
	svc, _ := newMapService(t, nil)

	cases := []struct {
		name string
		doc  string
	}{
		{"不是 JSON", `{`},
		{"format 不对", `{"format":"xmind","sheets":[{"rootTopic":{"id":"r","title":"t"}}]}`},
		{"没有画布", `{"format":"wmind","sheets":[]}`},
		{"没有中心主题", `{"format":"wmind","sheets":[{"rootTopic":null}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Create(context.Background(), 1, CreateMapInput{Document: []byte(tc.doc)})
			if code := codeOf(t, err); code != apperr.CodeDocumentInvalid {
				t.Errorf("code = %s，期望 %s", code, apperr.CodeDocumentInvalid)
			}
		})
	}
}

func TestCreateEnforcesMapLimit(t *testing.T) {
	svc, _ := newMapService(t, fakeLimits{mapsPerUser: 1})

	if _, err := svc.Create(context.Background(), 1, CreateMapInput{Document: validDoc(t, "a")}); err != nil {
		t.Fatalf("第一次创建应该成功: %v", err)
	}
	_, err := svc.Create(context.Background(), 1, CreateMapInput{Document: validDoc(t, "b")})
	if code := codeOf(t, err); code != apperr.CodeMapLimitReached {
		t.Errorf("code = %s，期望 %s", code, apperr.CodeMapLimitReached)
	}

	// 上限 0 表示不限制。
	unlimited, _ := newMapService(t, fakeLimits{mapsPerUser: 0})
	for i := 0; i < 3; i++ {
		if _, err := unlimited.Create(context.Background(), 1, CreateMapInput{Document: validDoc(t, "x")}); err != nil {
			t.Fatalf("不限量时第 %d 次创建失败: %v", i+1, err)
		}
	}
}

func TestCreateRejectsOversizedDocument(t *testing.T) {
	repo := newFakeMapRepo()
	svc, err := NewMapService(MapServiceConfig{Maps: repo, MaxDocumentBytes: 16})
	if err != nil {
		t.Fatalf("NewMapService: %v", err)
	}
	_, createErr := svc.Create(context.Background(), 1, CreateMapInput{Document: validDoc(t, "x")})
	if code := codeOf(t, createErr); code != apperr.CodeDocumentTooLarge {
		t.Errorf("code = %s，期望 %s", code, apperr.CodeDocumentTooLarge)
	}
}

func TestSaveVersionConflictReportsCurrentVersion(t *testing.T) {
	svc, _ := newMapService(t, nil)
	created, err := svc.Create(context.Background(), 1, CreateMapInput{Title: "图", Document: validDoc(t, "图")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 先正常保存一次，把服务端版本推到 2。
	if _, err := svc.Save(context.Background(), created.UID, 1, SaveMapInput{
		Version: created.Version, Title: "图", Document: validDoc(t, "图"),
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// 拿旧版本再存一次 → 冲突，且 details 里要有当前版本。
	_, err = svc.Save(context.Background(), created.UID, 1, SaveMapInput{
		Version: created.Version, Title: "图", Document: validDoc(t, "图"),
	})
	appErr := apperr.From(err)
	if appErr == nil || appErr.Code != apperr.CodeMapVersionConflict {
		t.Fatalf("期望 MAP_VERSION_CONFLICT，得到 %v", err)
	}
	if got := appErr.Details["currentVersion"]; got != 2 {
		t.Errorf("details.currentVersion = %v，期望 2", got)
	}
}

func TestSaveAndGetAreOwnerScoped(t *testing.T) {
	svc, _ := newMapService(t, nil)
	created, err := svc.Create(context.Background(), 1, CreateMapInput{Document: validDoc(t, "私有")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	_, err = svc.Get(context.Background(), created.UID, 2)
	if code := codeOf(t, err); code != apperr.CodeMapNotFound {
		t.Errorf("跨用户读取 code = %s，期望 %s", code, apperr.CodeMapNotFound)
	}
	if _, err := svc.Get(context.Background(), created.UID, 1); err != nil {
		t.Errorf("属主读取失败: %v", err)
	}
}

func TestDuplicateAppendsSuffixAndClampsTitle(t *testing.T) {
	svc, _ := newMapService(t, nil)

	short, err := svc.Create(context.Background(), 1, CreateMapInput{Title: "产品规划", Document: validDoc(t, "x")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	copied, err := svc.Duplicate(context.Background(), short.UID, 1)
	if err != nil {
		t.Fatalf("Duplicate: %v", err)
	}
	if copied.Title != "产品规划 - 副本" {
		t.Errorf("副本标题 = %q", copied.Title)
	}
	if copied.UID == short.UID {
		t.Error("副本必须换新 uid")
	}

	long := strings.Repeat("长", maxMapTitleRunes)
	source, err := svc.Create(context.Background(), 1, CreateMapInput{Title: long, Document: validDoc(t, "x")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	copied, err = svc.Duplicate(context.Background(), source.UID, 1)
	if err != nil {
		t.Fatalf("Duplicate: %v", err)
	}
	if runes := len([]rune(copied.Title)); runes > maxMapTitleRunes {
		t.Errorf("副本标题 %d 字，超过上限 %d", runes, maxMapTitleRunes)
	}
}

func TestListEscapesLikeWildcards(t *testing.T) {
	svc, repo := newMapService(t, nil)
	if _, _, err := svc.List(context.Background(), 1, "100%_a\\b", 1, 20); err != nil {
		t.Fatalf("List: %v", err)
	}
	want := `%100\%\_a\\b%`
	if repo.lastPattern != want {
		t.Errorf("LIKE 模式 = %q，期望 %q", repo.lastPattern, want)
	}
}

func TestTrashLifecycle(t *testing.T) {
	svc, _ := newMapService(t, nil)
	created, err := svc.Create(context.Background(), 1, CreateMapInput{Document: validDoc(t, "x")})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := svc.Delete(context.Background(), created.UID, 1); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := svc.Get(context.Background(), created.UID, 1); codeOf(t, err) != apperr.CodeMapNotFound {
		t.Error("删除后应该读不到")
	}
	trashed, total, err := svc.ListTrash(context.Background(), 1, 1, 20)
	if err != nil || len(trashed) != 1 || total != 1 {
		t.Fatalf("回收站 = %d 项（total %d, err %v）", len(trashed), total, err)
	}

	if _, err := svc.Restore(context.Background(), created.UID, 1); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if _, err := svc.Get(context.Background(), created.UID, 1); err != nil {
		t.Errorf("恢复后应该读得到: %v", err)
	}

	if err := svc.Delete(context.Background(), created.UID, 1); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := svc.EmptyTrash(context.Background(), 1); err != nil {
		t.Fatalf("EmptyTrash: %v", err)
	}
	trashed, total, err = svc.ListTrash(context.Background(), 1, 1, 20)
	if err != nil || len(trashed) != 0 || total != 0 {
		t.Errorf("清空后回收站应为空，得到 %d 项", len(trashed))
	}
}

func TestSaveRejectsUnknownMap(t *testing.T) {
	svc, _ := newMapService(t, nil)
	_, err := svc.Save(context.Background(), "nope", 1, SaveMapInput{Version: 1, Document: validDoc(t, "x")})
	if code := codeOf(t, err); code != apperr.CodeMapNotFound {
		t.Errorf("code = %s，期望 %s", code, apperr.CodeMapNotFound)
	}
}

func TestNewMapServiceRequiresRepo(t *testing.T) {
	if _, err := NewMapService(MapServiceConfig{}); err == nil {
		t.Fatal("缺少仓储时应该报错")
	}
}

func TestMapErrorMapping(t *testing.T) {
	if got := mapMapError(nil); got != nil {
		t.Errorf("nil 应原样返回，得到 %v", got)
	}
	if code := apperr.From(mapMapError(domain.ErrNotFound)).Code; code != apperr.CodeMapNotFound {
		t.Errorf("code = %s", code)
	}
	if code := apperr.From(mapMapError(errors.New("boom"))).Code; code != apperr.CodeInternalError {
		t.Errorf("code = %s", code)
	}
}
