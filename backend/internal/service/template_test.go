package service

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// fakeTemplateRepo 是内存版模板仓储。
//
// 与 fakeThemeRepo 同样的约定：只实现测试真正走到的方法，其余由内嵌的 nil
// 接口提供，被调用即 panic。
//
// 列表刻意**不填 Document**，与真实查询保持一致（`ListTemplatesByOwner`
// 不选 document 列）。不模拟这一点，就会让「列表把文档也带出来了」这种
// 真实缺陷在测试里看不出来。
type fakeTemplateRepo struct {
	domain.TemplateRepo

	mu     sync.Mutex
	nextID int64
	rows   []*domain.Template
}

func newFakeTemplateRepo() *fakeTemplateRepo { return &fakeTemplateRepo{} }

func (r *fakeTemplateRepo) clone(v *domain.Template) *domain.Template {
	copied := *v
	copied.Document = append([]byte(nil), v.Document...)
	return &copied
}

// find 同时匹配「自己的」与「内置（owner_id 为 NULL）」，与真实查询一致：
// 只匹配自己的会让「内置模板不可修改」这条守卫永远走不到。
func (r *fakeTemplateRepo) find(uid string, ownerID int64) *domain.Template {
	for _, row := range r.rows {
		if row.UID != uid {
			continue
		}
		if row.OwnerID == nil || *row.OwnerID == ownerID {
			return row
		}
	}
	return nil
}

func (r *fakeTemplateRepo) ListByOwner(_ context.Context, ownerID int64) ([]*domain.Template, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Template, 0, len(r.rows))
	for _, row := range r.rows {
		if row.OwnerID == nil || *row.OwnerID == ownerID {
			v := r.clone(row)
			v.Document = nil
			out = append(out, v)
		}
	}
	return out, nil
}

func (r *fakeTemplateRepo) GetByUID(_ context.Context, uid string, ownerID int64) (*domain.Template, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID)
	if row == nil {
		return nil, domain.ErrNotFound
	}
	return r.clone(row), nil
}

func (r *fakeTemplateRepo) CountByOwner(_ context.Context, ownerID int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var total int64
	for _, row := range r.rows {
		if row.OwnerID != nil && *row.OwnerID == ownerID {
			total++
		}
	}
	return total, nil
}

func (r *fakeTemplateRepo) Create(_ context.Context, in domain.CreateTemplateInput) (*domain.Template, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	owner := in.OwnerID
	row := &domain.Template{
		ID: r.nextID, UID: in.UID, OwnerID: &owner, Name: in.Name,
		Category: in.Category, Structure: in.Structure,
		Document:     append([]byte(nil), in.Document...),
		ThumbnailURL: in.ThumbnailURL, SortOrder: 0,
		CreatedAt: in.Now, UpdatedAt: in.Now,
	}
	r.rows = append(r.rows, row)
	return r.clone(row), nil
}

func (r *fakeTemplateRepo) Rename(_ context.Context, in domain.RenameTemplateInput) (*domain.Template, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(in.UID, in.OwnerID)
	if row == nil || row.IsBuiltin {
		return nil, domain.ErrNotFound
	}
	row.Name = in.Name
	row.UpdatedAt = in.Now
	return r.clone(row), nil
}

func (r *fakeTemplateRepo) Delete(_ context.Context, uid string, ownerID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for index, row := range r.rows {
		if row.UID == uid && row.OwnerID != nil && *row.OwnerID == ownerID && !row.IsBuiltin {
			r.rows = append(r.rows[:index], r.rows[index+1:]...)
			return nil
		}
	}
	return domain.ErrNotFound
}

// seedBuiltin 放一条内置模板进去，用来验「不可改名 / 不可删除」。
func (r *fakeTemplateRepo) seedBuiltin(uid, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	row := &domain.Template{
		ID: r.nextID, UID: uid, Name: name, Category: "basic",
		Structure: "mindmap", Document: []byte(`{"format":"wmind"}`),
		IsBuiltin: true, CreatedAt: time.Unix(0, 0).UTC(),
	}
	r.rows = append(r.rows, row)
}

type fakeTemplatePolicy struct{ enabled bool }

func (p fakeTemplatePolicy) UserTemplateEnabled() bool { return p.enabled }

type templateFixture struct {
	svc       *TemplateService
	templates *fakeTemplateRepo
	maps      *fakeMapRepo
	policy    *fakeTemplatePolicy
}

func newTemplateService(t *testing.T, maxPerUser int) *templateFixture {
	t.Helper()
	repo := newFakeTemplateRepo()
	maps := newFakeMapRepo()
	policy := &fakeTemplatePolicy{enabled: true}
	svc, err := NewTemplateService(TemplateServiceConfig{
		Templates: repo, Maps: maps, Policy: policy, MaxPerUser: maxPerUser,
	})
	if err != nil {
		t.Fatalf("NewTemplateService: %v", err)
	}
	return &templateFixture{svc: svc, templates: repo, maps: maps, policy: policy}
}

// seedMap 造一张源导图。
func (f *templateFixture) seedMap(t *testing.T, ownerID int64, structure string) *domain.Map {
	t.Helper()
	document := map[string]any{
		"format":        "wmind",
		"formatVersion": "1.0",
		"id":            "doc-1",
		"title":         "源导图",
		"sheets": []any{
			map[string]any{
				"id":        "sheet-1",
				"title":     "画布 1",
				"structure": structure,
				"rootTopic": map[string]any{"id": "root-1", "title": "中心主题"},
			},
		},
	}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	created, err := f.maps.Create(context.Background(), domain.CreateMapInput{
		UID: "map-1", OwnerID: ownerID, Title: "源导图",
		Document: raw, Now: time.Unix(0, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("seed map: %v", err)
	}
	return created
}

func TestTemplateCreateFromMapCopiesDocument(t *testing.T) {
	f := newTemplateService(t, 0)
	f.seedMap(t, 7, "org-chart")

	created, err := f.svc.CreateFromMap(context.Background(), 7, CreateFromMapInput{
		Name: "  组织架构  ", MapUID: "map-1",
	})
	if err != nil {
		t.Fatalf("CreateFromMap: %v", err)
	}
	if created.Name != "组织架构" {
		t.Fatalf("名字应去空白，得到 %q", created.Name)
	}
	if created.Structure != "org-chart" {
		t.Fatalf("结构应从文档里取到 org-chart，得到 %q", created.Structure)
	}
	if created.Category != domain.TemplateCategoryUser {
		t.Fatalf("分类应恒为 user，得到 %q", created.Category)
	}
	if created.IsBuiltin {
		t.Fatal("API 创建的模板不应是内置")
	}
	var document map[string]any
	if err := json.Unmarshal(created.Document, &document); err != nil {
		t.Fatalf("模板文档不是合法 JSON: %v", err)
	}
	if document["title"] != "源导图" {
		t.Fatalf("文档应原样复制，title = %v", document["title"])
	}
}

func TestTemplateCreateFallsBackToMindmap(t *testing.T) {
	f := newTemplateService(t, 0)
	// 文档里没有 structure：仍然应该成功，兜底成 mindmap。
	if _, err := f.maps.Create(context.Background(), domain.CreateMapInput{
		UID: "map-2", OwnerID: 7, Title: "无结构",
		Document: []byte(`{"format":"wmind","sheets":[{"rootTopic":{"id":"r","title":"x"}}]}`),
		Now:      time.Unix(0, 0).UTC(),
	}); err != nil {
		t.Fatalf("seed map: %v", err)
	}

	created, err := f.svc.CreateFromMap(context.Background(), 7, CreateFromMapInput{
		Name: "无结构模板", MapUID: "map-2",
	})
	if err != nil {
		t.Fatalf("CreateFromMap: %v", err)
	}
	if created.Structure != defaultTemplateStructure {
		t.Fatalf("结构缺失应兜底成 %q，得到 %q", defaultTemplateStructure, created.Structure)
	}
}

func TestTemplateCreateRejectsBadInput(t *testing.T) {
	f := newTemplateService(t, 0)
	f.seedMap(t, 7, "mindmap")

	cases := []struct {
		name  string
		input CreateFromMapInput
		field string
	}{
		{"空名字", CreateFromMapInput{Name: "   ", MapUID: "map-1"}, "name"},
		{"名字过长", CreateFromMapInput{Name: strings.Repeat("字", 65), MapUID: "map-1"}, "name"},
		{"缺 mapUid", CreateFromMapInput{Name: "模板"}, "mapUid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := f.svc.CreateFromMap(context.Background(), 7, tc.input)
			appErr, ok := err.(*apperr.Error)
			if !ok {
				t.Fatalf("期望 *apperr.Error，得到 %T: %v", err, err)
			}
			if appErr.Code != apperr.CodeValidationFailed {
				t.Fatalf("期望 VALIDATION_FAILED，得到 %s", appErr.Code)
			}
			if _, ok := appErr.Details["fields"].(map[string]string)[tc.field]; !ok {
				t.Fatalf("期望字段错误 %q，得到 %v", tc.field, appErr.Details["fields"])
			}
		})
	}
}

func TestTemplateCreateRequiresOwnMap(t *testing.T) {
	f := newTemplateService(t, 0)
	f.seedMap(t, 7, "mindmap")

	// 别人的导图 → 与「不存在」同一个错误码。
	_, err := f.svc.CreateFromMap(context.Background(), 8, CreateFromMapInput{
		Name: "偷别人的", MapUID: "map-1",
	})
	appErr, ok := err.(*apperr.Error)
	if !ok || appErr.Code != apperr.CodeMapNotFound {
		t.Fatalf("跨用户另存应返回 MAP_NOT_FOUND，得到 %v", err)
	}

	// 回收站里的导图：仓储的 GetByUID 带 deleted_at IS NULL，同样读不到。
	if err := f.maps.SoftDelete(context.Background(), "map-1", 7, time.Unix(0, 0).UTC()); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	_, err = f.svc.CreateFromMap(context.Background(), 7, CreateFromMapInput{
		Name: "回收站里的", MapUID: "map-1",
	})
	appErr, ok = err.(*apperr.Error)
	if !ok || appErr.Code != apperr.CodeMapNotFound {
		t.Fatalf("回收站导图应返回 MAP_NOT_FOUND，得到 %v", err)
	}
}

func TestTemplateLimit(t *testing.T) {
	f := newTemplateService(t, 2)
	f.seedMap(t, 7, "mindmap")

	for index := 0; index < 2; index++ {
		if _, err := f.svc.CreateFromMap(context.Background(), 7, CreateFromMapInput{
			Name: "模板", MapUID: "map-1",
		}); err != nil {
			t.Fatalf("第 %d 次创建: %v", index+1, err)
		}
	}
	_, err := f.svc.CreateFromMap(context.Background(), 7, CreateFromMapInput{
		Name: "第三个", MapUID: "map-1",
	})
	appErr, ok := err.(*apperr.Error)
	if !ok || appErr.Code != apperr.CodeTemplateLimitReached {
		t.Fatalf("超限应返回 TEMPLATE_LIMIT_REACHED，得到 %v", err)
	}
}

func TestTemplateDisabledByPolicy(t *testing.T) {
	f := newTemplateService(t, 0)
	f.seedMap(t, 7, "mindmap")
	f.policy.enabled = false

	ctx := context.Background()
	if _, err := f.svc.List(ctx, 7); err == nil {
		t.Fatal("关闭后列表应被拒")
	} else if appErr, ok := err.(*apperr.Error); !ok || appErr.Code != apperr.CodeTemplateDisabled {
		t.Fatalf("期望 TEMPLATE_DISABLED，得到 %v", err)
	}
	if _, err := f.svc.CreateFromMap(ctx, 7, CreateFromMapInput{Name: "x", MapUID: "map-1"}); err == nil {
		t.Fatal("关闭后另存应被拒")
	}
	if err := f.svc.Delete(ctx, 7, "whatever"); err == nil {
		t.Fatal("关闭后删除应被拒")
	}
}

func TestTemplateListOmitsDocument(t *testing.T) {
	f := newTemplateService(t, 0)
	f.seedMap(t, 7, "timeline")
	created, err := f.svc.CreateFromMap(context.Background(), 7, CreateFromMapInput{
		Name: "时间轴模板", MapUID: "map-1",
	})
	if err != nil {
		t.Fatalf("CreateFromMap: %v", err)
	}

	items, err := f.svc.List(context.Background(), 7)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("期望 1 条，得到 %d", len(items))
	}
	if len(items[0].Document) != 0 {
		t.Fatalf("列表不应带文档，得到 %d 字节", len(items[0].Document))
	}
	if items[0].Structure != "timeline" {
		t.Fatalf("列表应带结构，得到 %q", items[0].Structure)
	}

	// 单条读取才带文档。
	full, err := f.svc.Get(context.Background(), 7, created.UID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(full.Document) == 0 {
		t.Fatal("单条读取应带文档")
	}
}

func TestTemplateRenameAndDelete(t *testing.T) {
	f := newTemplateService(t, 0)
	f.seedMap(t, 7, "mindmap")
	created, err := f.svc.CreateFromMap(context.Background(), 7, CreateFromMapInput{
		Name: "原名", MapUID: "map-1",
	})
	if err != nil {
		t.Fatalf("CreateFromMap: %v", err)
	}

	renamed, err := f.svc.Rename(context.Background(), 7, created.UID, "  新名  ")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if renamed.Name != "新名" {
		t.Fatalf("名字应去空白，得到 %q", renamed.Name)
	}

	// 跨用户改名 → TEMPLATE_NOT_FOUND。
	if _, err := f.svc.Rename(context.Background(), 8, created.UID, "抢"); err == nil {
		t.Fatal("跨用户改名应失败")
	} else if appErr, ok := err.(*apperr.Error); !ok || appErr.Code != apperr.CodeTemplateNotFound {
		t.Fatalf("期望 TEMPLATE_NOT_FOUND，得到 %v", err)
	}

	if err := f.svc.Delete(context.Background(), 7, created.UID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := f.svc.Delete(context.Background(), 7, created.UID); err == nil {
		t.Fatal("重复删除应返回 TEMPLATE_NOT_FOUND")
	}
}

func TestTemplateBuiltinIsReadonly(t *testing.T) {
	f := newTemplateService(t, 0)
	f.templates.seedBuiltin("builtin-1", "思维导图")

	if _, err := f.svc.Rename(context.Background(), 7, "builtin-1", "改名"); err == nil {
		t.Fatal("内置模板不应能改名")
	} else if appErr, ok := err.(*apperr.Error); !ok || appErr.Code != apperr.CodeTemplateBuiltinReadonly {
		t.Fatalf("期望 TEMPLATE_BUILTIN_READONLY，得到 %v", err)
	}

	if err := f.svc.Delete(context.Background(), 7, "builtin-1"); err == nil {
		t.Fatal("内置模板不应能删除")
	} else if appErr, ok := err.(*apperr.Error); !ok || appErr.Code != apperr.CodeTemplateBuiltinReadonly {
		t.Fatalf("期望 TEMPLATE_BUILTIN_READONLY，得到 %v", err)
	}
}

func TestTemplateStructureParsing(t *testing.T) {
	cases := []struct {
		name     string
		document string
		want     string
		wantErr  bool
	}{
		{"正常", `{"sheets":[{"structure":"brace"}]}`, "brace", false},
		{"没有画布", `{"sheets":[]}`, defaultTemplateStructure, false},
		{"结构是空白", `{"sheets":[{"structure":"   "}]}`, defaultTemplateStructure, false},
		{"没有 sheets 键", `{"format":"wmind"}`, defaultTemplateStructure, false},
		{"空文档", ``, defaultTemplateStructure, false},
		{"不是 JSON", `not json`, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := templateStructure([]byte(tc.document))
			if tc.wantErr {
				if err == nil {
					t.Fatal("期望报错")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("得到 %q，期望 %q", got, tc.want)
			}
		})
	}
}
