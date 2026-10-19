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

// fakeThemeRepo 是内存版主题仓储。
//
// 与 fakeMapRepo 同样的约定：只实现测试真正走到的方法，其余由内嵌的 nil
// 接口提供，被调用即 panic。
type fakeThemeRepo struct {
	domain.ThemeRepo

	mu     sync.Mutex
	nextID int64
	rows   []*domain.Theme
}

func newFakeThemeRepo() *fakeThemeRepo { return &fakeThemeRepo{} }

func (r *fakeThemeRepo) clone(v *domain.Theme) *domain.Theme {
	copied := *v
	copied.Config = append([]byte(nil), v.Config...)
	return &copied
}

func (r *fakeThemeRepo) find(uid string, ownerID int64) *domain.Theme {
	for _, row := range r.rows {
		if row.UID == uid && row.OwnerID != nil && *row.OwnerID == ownerID {
			return row
		}
	}
	return nil
}

func (r *fakeThemeRepo) ListByOwner(_ context.Context, ownerID int64) ([]*domain.Theme, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Theme, 0, len(r.rows))
	for _, row := range r.rows {
		if row.OwnerID != nil && *row.OwnerID == ownerID {
			out = append(out, r.clone(row))
		}
	}
	return out, nil
}

func (r *fakeThemeRepo) GetByUID(_ context.Context, uid string, ownerID int64) (*domain.Theme, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(uid, ownerID)
	if row == nil {
		return nil, domain.ErrNotFound
	}
	return r.clone(row), nil
}

func (r *fakeThemeRepo) CountByOwner(_ context.Context, ownerID int64) (int64, error) {
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

func (r *fakeThemeRepo) Create(_ context.Context, in domain.CreateThemeInput) (*domain.Theme, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	ownerID := in.OwnerID
	row := &domain.Theme{
		ID: r.nextID, UID: in.UID, OwnerID: &ownerID, Name: in.Name, Category: in.Category,
		Config: append([]byte(nil), in.Config...), CreatedAt: in.Now, UpdatedAt: in.Now,
	}
	r.rows = append(r.rows, row)
	return r.clone(row), nil
}

func (r *fakeThemeRepo) Update(_ context.Context, in domain.UpdateThemeInput) (*domain.Theme, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row := r.find(in.UID, in.OwnerID)
	// 与真实 SQL 的 `is_builtin = false` 谓词等价。
	if row == nil || row.IsBuiltin {
		return nil, domain.ErrNotFound
	}
	row.Name = in.Name
	row.Config = append([]byte(nil), in.Config...)
	row.UpdatedAt = in.Now
	return r.clone(row), nil
}

func (r *fakeThemeRepo) Delete(_ context.Context, uid string, ownerID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, row := range r.rows {
		if row.UID == uid && row.OwnerID != nil && *row.OwnerID == ownerID && !row.IsBuiltin {
			r.rows = append(r.rows[:i], r.rows[i+1:]...)
			return nil
		}
	}
	return domain.ErrNotFound
}

// themeConfig 造一份最小但合法的 Theme 配置。
func themeConfig(colors ...string) []byte {
	if len(colors) == 0 {
		colors = []string{"#FF0000", "#00FF00"}
	}
	raw, err := json.Marshal(map[string]any{
		"id":       "classic-rainbow",
		"name":     "经典彩虹",
		"category": "classic",
		"palette": map[string]any{
			"colors":          colors,
			"lineColors":      colors,
			"backgroundColor": "#FFFFFF",
		},
		"global": map[string]any{"fontFamily": "system", "fontSize": 14, "lineWidth": 2},
		"layout": map[string]any{"compact": false, "autoBalance": true},
	})
	if err != nil {
		panic(err)
	}
	return raw
}

func newThemeService(t *testing.T, maxThemes int) (*ThemeService, *fakeThemeRepo) {
	t.Helper()
	repo := newFakeThemeRepo()
	fixed := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	svc, err := NewThemeService(ThemeServiceConfig{
		Themes: repo, Now: func() time.Time { return fixed }, MaxThemesPerUser: maxThemes,
	})
	if err != nil {
		t.Fatalf("NewThemeService: %v", err)
	}
	return svc, repo
}

func TestCreateThemeNormalizesConfigIdentity(t *testing.T) {
	svc, _ := newThemeService(t, 0)
	created, err := svc.Create(context.Background(), 7, CreateThemeInput{
		Name:   "  我的配色  ",
		Config: themeConfig(),
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 名字去空白：库里存的是给人看的名字，前后空格会让排序与去重都变形。
	if created.Name != "我的配色" {
		t.Errorf("name = %q，期望去掉首尾空格", created.Name)
	}
	if created.Category != domain.ThemeCategoryCustom {
		t.Errorf("category = %q，期望 custom", created.Category)
	}

	// 关键断言：config 里的 id / name / category 必须被改写成库里的值。
	// 不改的话，一份自定义主题会顶着内置配色的 id 出现在列表里，前端按 id
	// 去重时会互相覆盖。
	var got map[string]any
	if err := json.Unmarshal(created.Config, &got); err != nil {
		t.Fatalf("config 不是合法 JSON: %v", err)
	}
	if got["id"] != created.UID {
		t.Errorf("config.id = %v，期望等于 uid %q", got["id"], created.UID)
	}
	if got["name"] != "我的配色" {
		t.Errorf("config.name = %v，期望 我的配色", got["name"])
	}
	if got["category"] != domain.ThemeCategoryCustom {
		t.Errorf("config.category = %v，期望 custom", got["category"])
	}
}

// 未知字段必须原样留住。前端给 Theme 加一个样式字段后，用户存一次主题
// 不该把那个字段吃掉——那是静默的数据丢失。
func TestCreateThemeKeepsUnknownConfigFields(t *testing.T) {
	svc, _ := newThemeService(t, 0)
	raw := themeConfig()
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	fields["brandNewField"] = "future"
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	created, err := svc.Create(context.Background(), 7, CreateThemeInput{Name: "前瞻", Config: raw})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(created.Config, &got); err != nil {
		t.Fatalf("config 不是合法 JSON: %v", err)
	}
	if got["brandNewField"] != "future" {
		t.Errorf("未知字段被丢弃了: %#v", got)
	}
}

func TestCreateThemeRejectsBadInput(t *testing.T) {
	cases := []struct {
		name  string
		input CreateThemeInput
		field string
	}{
		{
			name:  "空名字",
			input: CreateThemeInput{Name: "   ", Config: themeConfig()},
			field: "name",
		},
		{
			name:  "名字过长",
			input: CreateThemeInput{Name: strings.Repeat("主", 65), Config: themeConfig()},
			field: "name",
		},
		{
			name:  "缺少 config",
			input: CreateThemeInput{Name: "x"},
			field: "config",
		},
		{
			name:  "config 是 null",
			input: CreateThemeInput{Name: "x", Config: []byte("null")},
			field: "config",
		},
		{
			name:  "config 不是对象",
			input: CreateThemeInput{Name: "x", Config: []byte(`["#FFFFFF"]`)},
			field: "config",
		},
		{
			name: "缺少调色板颜色",
			input: CreateThemeInput{Name: "x", Config: func() []byte {
				return []byte(`{"palette":{"colors":[]},"global":{"fontFamily":"system","fontSize":14}}`)
			}()},
			field: "config",
		},
		{
			name: "颜色格式不对",
			input: CreateThemeInput{Name: "x", Config: func() []byte {
				return []byte(`{"palette":{"colors":["red"]},"global":{"fontFamily":"system","fontSize":14}}`)
			}()},
			field: "config",
		},
		{
			name: "字号非正",
			input: CreateThemeInput{Name: "x", Config: func() []byte {
				return []byte(`{"palette":{"colors":["#FFFFFF"]},"global":{"fontFamily":"system","fontSize":0}}`)
			}()},
			field: "config",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, repo := newThemeService(t, 0)
			_, err := svc.Create(context.Background(), 7, tc.input)
			if err == nil {
				t.Fatal("期望报错，实际成功")
			}
			appErr := apperr.From(err)
			if appErr == nil || appErr.Code != apperr.CodeValidationFailed {
				t.Fatalf("期望 VALIDATION_FAILED，得到 %v", err)
			}
			if _, ok := appErr.Details["fields"].(map[string]string)[tc.field]; !ok {
				t.Errorf("details.fields 里没有 %q: %#v", tc.field, appErr.Details)
			}
			if len(repo.rows) != 0 {
				t.Errorf("校验失败不应落库，实际写了 %d 行", len(repo.rows))
			}
		})
	}
}

func TestCreateThemeEnforcesLimit(t *testing.T) {
	svc, _ := newThemeService(t, 2)
	for i := 0; i < 2; i++ {
		if _, err := svc.Create(context.Background(), 7, CreateThemeInput{
			Name: "配色" + string(rune('A'+i)), Config: themeConfig(),
		}); err != nil {
			t.Fatalf("第 %d 个主题: %v", i+1, err)
		}
	}
	_, err := svc.Create(context.Background(), 7, CreateThemeInput{Name: "第三个", Config: themeConfig()})
	if code := codeOf(t, err); code != apperr.CodeThemeLimitReached {
		t.Fatalf("code = %s，期望 THEME_LIMIT_REACHED", code)
	}

	// 上限是「每人」的：另一个用户不受影响。
	if _, err := svc.Create(context.Background(), 8, CreateThemeInput{Name: "别人的", Config: themeConfig()}); err != nil {
		t.Fatalf("另一个用户不该受此人上限影响: %v", err)
	}
}

func TestUpdateThemeRejectsBuiltin(t *testing.T) {
	svc, repo := newThemeService(t, 0)
	owner := int64(7)
	repo.rows = append(repo.rows, &domain.Theme{
		ID: 1, UID: "builtin-1", OwnerID: &owner, Name: "内置", IsBuiltin: true,
		Config: themeConfig(),
	})

	_, err := svc.Update(context.Background(), 7, "builtin-1", UpdateThemeInput{Name: "改名", Config: themeConfig()})
	if code := codeOf(t, err); code != apperr.CodeThemeBuiltinReadonly {
		t.Fatalf("code = %s，期望 THEME_BUILTIN_READONLY", code)
	}
	// 报错文案不能是「主题不存在」：那会把「不可改」误导成「没了」。
	if err := svc.Delete(context.Background(), 7, "builtin-1"); codeOf(t, err) != apperr.CodeThemeBuiltinReadonly {
		t.Fatalf("删除内置主题 code = %s", codeOf(t, err))
	}
}

func TestThemeIsolationBetweenOwners(t *testing.T) {
	svc, _ := newThemeService(t, 0)
	created, err := svc.Create(context.Background(), 7, CreateThemeInput{Name: "我的", Config: themeConfig()})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 跨用户访问一律「不存在」，不是「无权限」——后者会泄露 uid 存在。
	if _, err := svc.Update(context.Background(), 8, created.UID, UpdateThemeInput{Name: "偷改", Config: themeConfig()}); codeOf(t, err) != apperr.CodeThemeNotFound {
		t.Fatalf("跨用户更新 code = %s，期望 THEME_NOT_FOUND", codeOf(t, err))
	}
	if err := svc.Delete(context.Background(), 8, created.UID); codeOf(t, err) != apperr.CodeThemeNotFound {
		t.Fatalf("跨用户删除 code = %s，期望 THEME_NOT_FOUND", codeOf(t, err))
	}

	list, err := svc.List(context.Background(), 8)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("别人的列表里出现了 %d 条主题", len(list))
	}
}

func TestUpdateThemeRewritesNameIntoConfig(t *testing.T) {
	svc, _ := newThemeService(t, 0)
	created, err := svc.Create(context.Background(), 7, CreateThemeInput{Name: "旧名", Config: themeConfig()})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	updated, err := svc.Update(context.Background(), 7, created.UID, UpdateThemeInput{
		Name: "新名", Config: themeConfig("#123456"),
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(updated.Config, &got); err != nil {
		t.Fatalf("config 不是合法 JSON: %v", err)
	}
	// 改名之后 config.name 必须跟着变，否则「列表里叫新名、应用时按 config
	// 取名」会出现两个名字。
	if got["name"] != "新名" {
		t.Errorf("config.name = %v，期望 新名", got["name"])
	}
	palette, _ := got["palette"].(map[string]any)
	colors, _ := palette["colors"].([]any)
	if len(colors) != 1 || colors[0] != "#123456" {
		t.Errorf("调色板没被更新: %#v", colors)
	}
	// uid 不能变：它是前端的引用键。
	if updated.UID != created.UID {
		t.Errorf("uid 变了: %s -> %s", created.UID, updated.UID)
	}
}

func TestMapThemeError(t *testing.T) {
	if code := apperr.From(mapThemeError(domain.ErrNotFound)).Code; code != apperr.CodeThemeNotFound {
		t.Errorf("code = %s", code)
	}
	// uid 撞号是熵源问题，必须按内部错误上报而不是「已存在」。
	if code := apperr.From(mapThemeError(domain.ErrDuplicate)).Code; code != apperr.CodeInternalError {
		t.Errorf("code = %s", code)
	}
}
