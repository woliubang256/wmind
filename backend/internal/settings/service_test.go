package settings_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/settings"
)

// fakeRepo 是内存版设置仓储。
//
// 用 map + mutex 而不是真实数据库：这一层要验的是「键的校验与快照语义」，
// 与 SQL 无关；真正的持久化由仓储契约测试覆盖。
type fakeRepo struct {
	mu   sync.Mutex
	rows map[string]string
	// writes 记录 Upsert 调用次数，用来断言「校验失败时一个键都没写」。
	writes int
	failOn string
}

func newFakeRepo() *fakeRepo { return &fakeRepo{rows: map[string]string{}} }

func (r *fakeRepo) List(context.Context) ([]*domain.Setting, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*domain.Setting, 0, len(r.rows))
	for key, value := range r.rows {
		out = append(out, &domain.Setting{Key: key, Value: value})
	}
	return out, nil
}

func (r *fakeRepo) Upsert(_ context.Context, key, value string, _ *int64, _ time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key == r.failOn {
		return errors.New("模拟写入失败")
	}
	r.rows[key] = value
	r.writes++
	return nil
}

func (r *fakeRepo) snapshot() map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]string, len(r.rows))
	for key, value := range r.rows {
		out[key] = value
	}
	return out
}

// fakeTx 用「失败就还原整张表」模拟事务回滚。
//
// 真事务的语义在仓储层由 SQLite/PostgreSQL 保证，这里要验的是 settings.Update
// 到底有没有把多个 Upsert 放进同一个事务。
type fakeTx struct{ repo *fakeRepo }

func (t *fakeTx) WithTx(ctx context.Context, fn func(ctx context.Context) error) error {
	t.repo.mu.Lock()
	before := make(map[string]string, len(t.repo.rows))
	for key, value := range t.repo.rows {
		before[key] = value
	}
	t.repo.mu.Unlock()

	if err := fn(ctx); err != nil {
		t.repo.mu.Lock()
		t.repo.rows = before
		t.repo.mu.Unlock()
		return err
	}
	return nil
}

func newService(t *testing.T, repo *fakeRepo) *settings.Service {
	t.Helper()
	svc, err := settings.New(repo, settings.Config{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Tx:     &fakeTx{repo: repo},
	})
	if err != nil {
		t.Fatalf("settings.New: %v", err)
	}
	return svc
}

func TestShareDefaultsAndExplicitOverrides(t *testing.T) {
	repo := newFakeRepo()
	svc := newService(t, repo)
	if got := svc.ShareDefaultExpireDays(); got != 7 {
		t.Fatalf("分享默认有效期 = %d，期望 7 天", got)
	}
	if svc.ShareDefaultAllowDownload() {
		t.Fatal("分享默认不应允许下载")
	}
	// 已有管理员显式设置不能被默认值变更覆盖。
	repo.rows["share.default_expire_days"] = "30"
	repo.rows["share.default_allow_download"] = "true"
	if err := svc.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if svc.ShareDefaultExpireDays() != 30 || !svc.ShareDefaultAllowDownload() {
		t.Fatal("分享显式设置未被保留")
	}
}

// fieldErrors 取出 SETTINGS_INVALID 的字段级错误。
func fieldErrors(t *testing.T, err error) map[string]string {
	t.Helper()
	var appErr *apperr.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("期望 *apperr.Error，得到 %T", err)
	}
	if appErr.Code != apperr.CodeSettingsInvalid {
		t.Fatalf("错误码 = %s; 期望 SETTINGS_INVALID", appErr.Code)
	}
	fields, _ := appErr.Details["fields"].(map[string]string)
	if fields == nil {
		t.Fatalf("缺少 details.fields: %#v", appErr.Details)
	}
	return fields
}

func TestDefaultsBeforeLoad(t *testing.T) {
	svc := newService(t, newFakeRepo())

	// Load 之前就必须可用：启动早期可能有请求进来，不能 panic 或读到零值。
	snapshot := svc.Snapshot()
	if snapshot.SiteName() != "wmind" {
		t.Fatalf("站点名 = %q; 期望 wmind", snapshot.SiteName())
	}
	if !svc.RegistrationEnabled() {
		t.Fatal("默认应开放注册")
	}
	if got := svc.PasswordMinLength(); got != 8 {
		t.Fatalf("密码最小长度 = %d; 期望 8", got)
	}
}

func TestUpdatePersistsAndReloads(t *testing.T) {
	repo := newFakeRepo()
	svc := newService(t, repo)

	snapshot, err := svc.Update(context.Background(), map[string]any{
		"site.name":                     "我们的导图",
		"auth.registration_enabled":     false,
		"auth.password_min_length":      12,
		"feature.user_template_enabled": false,
	}, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if snapshot.SiteName() != "我们的导图" || snapshot.RegistrationEnabled() {
		t.Fatalf("返回的快照没跟上改动: %#v", snapshot.All())
	}

	// 存储形式是 JSON 文本：字符串带引号、布尔与整数是裸字面量。
	stored := repo.snapshot()
	if stored["site.name"] != `"我们的导图"` {
		t.Fatalf("site.name 存储值 = %s", stored["site.name"])
	}
	if stored["auth.registration_enabled"] != "false" || stored["auth.password_min_length"] != "12" {
		t.Fatalf("存储值不对: %#v", stored)
	}

	// 立刻生效：认证流程读的是 Service 而不是某份旧快照。
	if svc.RegistrationEnabled() {
		t.Fatal("关闭注册后 Service.RegistrationEnabled 应立刻为 false")
	}
}

func TestUpdateRejectsInvalidWithoutWriting(t *testing.T) {
	cases := []struct {
		name  string
		patch map[string]any
		key   string
	}{
		{"未知键", map[string]any{"site.unknown": "x"}, "site.unknown"},
		{"布尔给了字符串", map[string]any{"auth.registration_enabled": "true"}, "auth.registration_enabled"},
		{"整数给了小数", map[string]any{"limit.upload_max_mb": 1.5}, "limit.upload_max_mb"},
		{"整数越界", map[string]any{"auth.password_min_length": 4}, "auth.password_min_length"},
		{"字符串为空", map[string]any{"site.name": ""}, "site.name"},
		{"字符串过长", map[string]any{"site.name": "名" + string(make([]rune, 100))}, "site.name"},
		{"枚举外的值", map[string]any{"auth.default_role": "root"}, "auth.default_role"},
		{"字符串给了数字", map[string]any{"site.name": 42}, "site.name"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := newFakeRepo()
			svc := newService(t, repo)

			_, err := svc.Update(context.Background(), tc.patch, nil)
			fields := fieldErrors(t, err)
			if fields[tc.key] == "" {
				t.Fatalf("字段错误应指向 %s，实际 %#v", tc.key, fields)
			}
			// 校验在写入之前完成：任何键都不该落库。
			if got := repo.snapshot(); len(got) != 0 {
				t.Fatalf("校验失败不应写库，实际写了 %#v", got)
			}
		})
	}
}

func TestUpdateReportsAllFieldErrors(t *testing.T) {
	svc := newService(t, newFakeRepo())

	// 两个键都非法时应一次报全，而不是让管理员改一个再发现下一个。
	_, err := svc.Update(context.Background(), map[string]any{
		"auth.password_min_length": 2,
		"limit.upload_max_mb":      0,
	}, nil)
	fields := fieldErrors(t, err)
	if len(fields) != 2 {
		t.Fatalf("应同时报出两个字段错误，实际 %#v", fields)
	}
}

func TestUpdateIsAtomicOnWriteFailure(t *testing.T) {
	repo := newFakeRepo()
	// 让排序在后面的键写失败：前面已经写成功的键必须被回滚。
	// 排序是 limit.* → site.*，所以 site.name 是第二个写的。
	repo.failOn = "site.name"
	svc := newService(t, repo)

	_, err := svc.Update(context.Background(), map[string]any{
		"site.name":           "改了一半",
		"limit.upload_max_mb": 20,
	}, nil)
	if err == nil {
		t.Fatal("写入失败应返回错误")
	}
	if got := repo.snapshot(); len(got) != 0 {
		t.Fatalf("有事务时写入应整体回滚，实际 %#v", got)
	}
}

func TestUpdateEmptyPatchIsNoop(t *testing.T) {
	repo := newFakeRepo()
	svc := newService(t, repo)

	snapshot, err := svc.Update(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("空 patch 不该报错: %v", err)
	}
	if snapshot.SiteName() != "wmind" || repo.writes != 0 {
		t.Fatalf("空 patch 不该写库: writes=%d", repo.writes)
	}
}

func TestLoadIgnoresUnknownAndCorruptRows(t *testing.T) {
	repo := newFakeRepo()
	// 一个未知键（降级运行的残留）、一个损坏值、一个正常值。
	repo.rows["site.legacy_key"] = `"gone"`
	repo.rows["limit.upload_max_mb"] = `"not-a-number"`
	repo.rows["site.name"] = `"正常名字"`

	svc := newService(t, repo)
	if err := svc.Load(context.Background()); err != nil {
		t.Fatalf("Load: %v", err)
	}

	snapshot := svc.Snapshot()
	if snapshot.SiteName() != "正常名字" {
		t.Fatalf("正常键应生效，实际 %q", snapshot.SiteName())
	}
	if got := snapshot.UploadMaxMB(); got != 10 {
		t.Fatalf("损坏的键应退回默认值 10，实际 %d", got)
	}
	if _, ok := snapshot.All()["site.legacy_key"]; ok {
		t.Fatal("未知键不该进入快照")
	}
}

func TestPublicExcludesSensitiveKeys(t *testing.T) {
	svc := newService(t, newFakeRepo())

	public := svc.Snapshot().Public()
	for _, key := range []string{"site.name", "auth.registration_enabled", "feature.export_enabled"} {
		if _, ok := public[key]; !ok {
			t.Fatalf("公开配置缺少 %s", key)
		}
	}
	for _, key := range []string{"auth.login_max_attempts", "auth.login_lock_minutes", "limit.upload_max_mb", "auth.default_role"} {
		if _, ok := public[key]; ok {
			t.Fatalf("%s 属敏感配置，不该出现在公开配置里", key)
		}
	}
}

func TestAllCoversEverySpec(t *testing.T) {
	svc := newService(t, newFakeRepo())

	all := svc.Snapshot().All()
	for _, spec := range settings.Specs() {
		if _, ok := all[spec.Key]; !ok {
			t.Fatalf("快照缺少设置项 %s", spec.Key)
		}
	}
	// 反向：快照里不该有 schema 之外的键。
	for key := range all {
		if _, ok := settings.Lookup(key); !ok {
			t.Fatalf("快照里有 schema 之外的键 %s", key)
		}
	}
}

func TestReloadPicksUpExternalChange(t *testing.T) {
	repo := newFakeRepo()
	svc := newService(t, repo)
	if !svc.RegistrationEnabled() {
		t.Fatal("初始应开放注册")
	}

	// 模拟另一个实例改了库。
	repo.rows["auth.registration_enabled"] = "false"
	if err := svc.Reload(context.Background()); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if svc.RegistrationEnabled() {
		t.Fatal("Reload 后应看到外部改动")
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	svc, err := settings.New(newFakeRepo(), settings.Config{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		TTL:    10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("settings.New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.Run(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run 没有在 ctx 取消后退出")
	}
}

func TestNewRejectsMissingRepo(t *testing.T) {
	if _, err := settings.New(nil, settings.Config{}); err == nil {
		t.Fatal("缺少仓储时应返回错误")
	}
}
