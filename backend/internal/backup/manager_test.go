package backup_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/backup"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
)

type remoteStub struct {
	mu         sync.Mutex
	data       []byte
	block      chan struct{}
	entered    chan struct{}
	fail       bool
	count      int
	objects    map[string]bool
	deleted    []string
	deleteFail bool
	checkFail  bool
}

func (r *remoteStub) Test(context.Context, backup.Configuration) error { return nil }
func (r *remoteStub) Exists(_ context.Context, _ backup.Configuration, name string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.checkFail {
		return false, errors.New("object check failed")
	}
	return r.objects[name], nil
}

type failingCatalogSettings struct{ domain.SettingsRepo }

func (s failingCatalogSettings) Upsert(ctx context.Context, key, value string, actor *int64, now time.Time) error {
	if key == "backup.catalog" {
		return errors.New("catalog write failed")
	}
	return s.SettingsRepo.Upsert(ctx, key, value, actor, now)
}
func (r *remoteStub) Delete(_ context.Context, _ backup.Configuration, name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.deleteFail {
		return errors.New("delete denied")
	}
	delete(r.objects, name)
	r.deleted = append(r.deleted, name)
	return nil
}
func (r *remoteStub) Upload(ctx context.Context, _ backup.Configuration, name, filename string) error {
	if r.entered != nil {
		close(r.entered)
	}
	if r.block != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.block:
		}
	}
	if r.fail {
		return errors.New("remote unavailable")
	}
	data, err := os.ReadFile(filename)
	r.mu.Lock()
	r.data = data
	r.count++
	if r.objects == nil {
		r.objects = make(map[string]bool)
	}
	r.objects[name] = true
	r.mu.Unlock()
	return err
}

type managerFixture struct {
	manager  *backup.Manager
	db       *sql.DB
	uploads  string
	work     string
	remote   *remoteStub
	auth     *service.AuthService
	oldToken string
	ctx      context.Context
	cancel   context.CancelFunc
}

func newManagerFixture(t *testing.T) *managerFixture {
	t.Helper()
	root := t.TempDir()
	db, err := sqlite.Open(filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = migrate.Up("sqlite", db, log); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO users(id,uid,username,email,password_hash,role) VALUES (1,'admin','admin','admin@example.com','hash','admin')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO maps(uid,owner_id,title,document) VALUES('map',1,'original','{}')`); err != nil {
		t.Fatal(err)
	}
	uploads := filepath.Join(root, "uploads")
	os.MkdirAll(uploads, 0700)
	os.WriteFile(filepath.Join(uploads, "image.png"), []byte("original-image"), 0600)
	secret := strings.Repeat("s", 32)
	issuer, _ := auth.NewTokenIssuer(secret, time.Minute)
	authSvc, err := service.NewAuthService(sqlite.NewUserRepository(db), sqlite.NewRefreshTokenRepository(db), sqlite.NewTxManager(db), service.AuthServiceConfig{Issuer: issuer, RefreshTTL: time.Hour, TwoFactor: sqlite.NewTwoFactorRepository(db), TwoFactorKey: secret, UserCacheTTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	token, _, _ := issuer.Issue("admin", "admin")
	if _, err = authSvc.Authenticate(t.Context(), token); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	remote := &remoteStub{}
	cfg := backup.ManagerConfig{Repository: sqlite.NewBackupRepository(db), Settings: sqlite.NewSettingsRepository(db), UploadDir: uploads, WorkDir: filepath.Join(root, "work"), Secret: secret, Logger: log, Remote: remote, AfterRestore: func(context.Context) error { authSvc.InvalidateAllUsers(); return nil }}
	manager, err := backup.NewManager(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); manager.Wait() })
	c := backup.DefaultConfiguration()
	c.WebDAV.URL = "https://example.com/backups"
	c.WebDAV.Password = "private-password"
	c.Enabled = true
	if err = manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	return &managerFixture{manager: manager, db: db, uploads: uploads, work: cfg.WorkDir, remote: remote, auth: authSvc, oldToken: token, ctx: ctx, cancel: cancel}
}
func waitJob(t *testing.T, m *backup.Manager) backup.Job {
	t.Helper()
	m.Wait()
	state := m.State()
	if state.Current == nil {
		t.Fatal("no job")
	}
	return *state.Current
}

func runBackup(t *testing.T, f *managerFixture, trigger string) backup.Job {
	t.Helper()
	if _, err := f.manager.StartBackup(trigger); err != nil {
		t.Fatal(err)
	}
	return waitJob(t, f.manager)
}

func TestRetentionCountsSuccessfulManualAndScheduledObjectsBeyondHistory(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.RetainCount = 30
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	f.remote.objects = map[string]bool{"unrelated.zip": true}
	for i := 0; i < 33; i++ {
		trigger := "manual"
		if i%2 == 1 {
			trigger = "schedule"
		}
		if job := runBackup(t, f, trigger); job.Status != "succeeded" || job.WarningCode != "" {
			t.Fatal(job)
		}
	}
	if len(f.manager.State().History) != 20 || len(f.remote.objects) != 31 || len(f.remote.deleted) != 3 || !f.remote.objects["unrelated.zip"] {
		t.Fatal("bad retention", len(f.remote.objects), len(f.remote.deleted))
	}
	if err := f.manager.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	c.RetainCount = 2
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	if len(f.remote.objects) != 31 {
		t.Fatal("saving settings deleted objects")
	}
	f.remote.fail = true
	if job := runBackup(t, f, "manual"); job.Status != "failed" {
		t.Fatal(job)
	}
	if len(f.remote.objects) != 31 {
		t.Fatal("failed upload deleted old backups")
	}
	f.remote.fail = false
	if job := runBackup(t, f, "schedule"); job.WarningCode != "" {
		t.Fatal(job)
	}
	if len(f.remote.objects) != 3 {
		t.Fatal("history truncation/reload lost catalog", len(f.remote.objects))
	}
}

func TestRetentionCleanupWarningRetryAndTargetIsolation(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.RetainCount = 1
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	first := runBackup(t, f, "manual")
	f.remote.deleteFail = true
	second := runBackup(t, f, "manual")
	if second.Status != "succeeded" || second.WarningCode != "CLEANUP_FAILED" || len(f.remote.objects) != 2 {
		t.Fatal(second)
	}
	f.remote.deleteFail = false
	if job := runBackup(t, f, "schedule"); job.WarningCode != "" || len(f.remote.objects) != 1 {
		t.Fatal(job, len(f.remote.objects))
	}
	if f.remote.objects[first.Filename] {
		t.Fatal("old backup survived successful cleanup")
	}
	previous := f.manager.State().Current.Filename
	c.WebDAV.URL = "https://example.com/other"
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	runBackup(t, f, "manual")
	runBackup(t, f, "manual")
	if len(f.remote.objects) != 2 || !f.remote.objects[previous] {
		t.Fatal("cleaned another target")
	}
}

func TestOptionalDedupIgnoresReadingButIncludesBusinessAndSecurity(t *testing.T) {
	f := newManagerFixture(t)
	first := runBackup(t, f, "manual")
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" || job.Filename == first.Filename {
		t.Fatal("default should always upload", job)
	}
	c := f.manager.State().Configuration
	c.SkipUnchanged = true
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	if job := runBackup(t, f, "schedule"); job.Status != "skipped" {
		t.Fatal("unchanged should skip", job)
	}
	queries := []string{
		`UPDATE users SET last_login_at='2026-10-24T10:00:00Z',updated_at='2026-10-24T10:00:00Z'`,
		`INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES(1,'new-login-token','2027-01-01T00:00:00Z')`,
		`INSERT INTO audit_logs(actor_id,action) VALUES(1,'auth.login')`,
		`INSERT INTO user_two_factor(user_id,state,revision) VALUES(1,'{"Enabled":false,"Secret":"","RecoveryHashes":null,"SessionVersion":"new-session","Challenges":[]}',1) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,revision=revision+1`,
	}
	for _, q := range queries {
		if _, err := f.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.manager.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	if job := runBackup(t, f, "manual"); job.Status != "skipped" {
		t.Fatal("login/reading/restart created backup", job)
	}
	changes := []string{
		`UPDATE maps SET title='edited'`,
		`INSERT INTO share_links(uid,token,map_id,owner_id) VALUES('share','token',1,1)`,
		`UPDATE share_links SET allow_download=0`,
		`UPDATE users SET password_hash='new-password-hash'`,
		`UPDATE user_two_factor SET state='{"Enabled":true,"Secret":"encrypted-secret","RecoveryHashes":["code"]}',revision=revision+1`,
		`INSERT INTO settings(key,value) VALUES('site.name','"new site"')`,
	}
	for _, q := range changes {
		if _, err := f.db.Exec(q); err != nil {
			t.Fatal(err)
		}
		if job := runBackup(t, f, "manual"); job.Status != "succeeded" {
			t.Fatal("business/security change skipped", q, job)
		}
		if job := runBackup(t, f, "schedule"); job.Status != "skipped" {
			t.Fatal("unchanged version repeated", job)
		}
	}
	if _, err := f.db.Exec(`UPDATE share_links SET view_count=view_count+1,last_viewed_at='2026-10-24T11:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	if job := runBackup(t, f, "manual"); job.Status != "skipped" {
		t.Fatal("share view changed version", job)
	}
	os.WriteFile(filepath.Join(f.uploads, "image.png"), []byte("new-image"), 0600)
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" {
		t.Fatal("file change skipped", job)
	}
	latest := f.manager.State().Current.Filename
	delete(f.remote.objects, latest)
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" {
		t.Fatal("missing remote object skipped", job)
	}
	c.WebDAV.URL = "https://example.com/new-target"
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" {
		t.Fatal("new target reused old baseline", job)
	}
	c.SkipUnchanged = false
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" {
		t.Fatal("disabled dedup still skipped", job)
	}
}

func TestRestorePreservesOwnedCatalogAndInvalidatesDedupBaseline(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.RetainCount = 2
	c.SkipUnchanged = true
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	runBackup(t, f, "manual")
	data := bytes.Clone(f.remote.data)
	f.db.Exec(`UPDATE maps SET title='newer'`)
	runBackup(t, f, "manual")
	preview, err := f.manager.Inspect(t.Context(), "admin", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.manager.StartRestore("admin", preview.ID); err != nil {
		t.Fatal(err)
	}
	if job := waitJob(t, f.manager); job.Status != "succeeded" {
		t.Fatal(job)
	}
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" || len(f.remote.objects) != 2 {
		t.Fatal("restore lost ownership/retention", job, len(f.remote.objects))
	}
	if job := runBackup(t, f, "manual"); job.Status != "skipped" {
		t.Fatal("new baseline was not registered", job)
	}
}

func TestDedupFailureNeverAdvancesBaselineAndSkippedJobsDoNotCount(t *testing.T) {
	f := newManagerFixture(t)
	for i := 0; i < 3; i++ {
		runBackup(t, f, "manual")
	}
	c := f.manager.State().Configuration
	c.RetainCount = 1
	c.SkipUnchanged = true
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	f.remote.checkFail = true
	if job := runBackup(t, f, "manual"); job.Status != "failed" || job.ErrorCode != "REMOTE_CHECK_FAILED" || len(f.remote.objects) != 3 {
		t.Fatal(job)
	}
	f.remote.checkFail = false
	if job := runBackup(t, f, "manual"); job.Status != "skipped" || len(f.remote.objects) != 1 {
		t.Fatal("skip must clean old quota without adding copy", job)
	}
	f.db.Exec(`UPDATE maps SET title='changed while upload fails'`)
	f.remote.fail = true
	if job := runBackup(t, f, "manual"); job.Status != "failed" || len(f.remote.objects) != 1 {
		t.Fatal(job)
	}
	f.remote.fail = false
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" {
		t.Fatal("failed upload incorrectly advanced baseline", job)
	}
}

func TestCatalogPersistenceFailureNeverDeletesPreviousCopies(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.RetainCount = 1
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	first := runBackup(t, f, "manual")
	m, err := backup.NewManager(f.ctx, backup.ManagerConfig{Repository: sqlite.NewBackupRepository(f.db), Settings: failingCatalogSettings{sqlite.NewSettingsRepository(f.db)}, UploadDir: f.uploads, WorkDir: f.work, Secret: strings.Repeat("s", 32), Remote: f.remote})
	if err != nil {
		t.Fatal(err)
	}
	f.manager = m
	t.Cleanup(m.Wait)
	if job := runBackup(t, f, "manual"); job.Status != "succeeded" || job.WarningCode != "CATALOG_FAILED" || !f.remote.objects[first.Filename] || len(f.remote.objects) != 2 {
		t.Fatal(job)
	}
	if len(f.remote.deleted) != 0 {
		t.Fatal("deleted before new copy durably registered")
	}
}
func TestManagerBackupUploadRestoreAndSessions(t *testing.T) {
	f := newManagerFixture(t)
	if _, err := f.manager.StartBackup("manual"); err != nil {
		t.Fatal(err)
	}
	if job := waitJob(t, f.manager); job.Status != "succeeded" || job.Bytes == 0 {
		t.Fatal(job)
	}
	f.remote.mu.Lock()
	data := bytes.Clone(f.remote.data)
	f.remote.mu.Unlock()
	f.db.Exec(`UPDATE maps SET title='changed'`)
	os.WriteFile(filepath.Join(f.uploads, "image.png"), []byte("changed-image"), 0600)
	os.WriteFile(filepath.Join(f.uploads, "extra.png"), []byte("extra"), 0600)
	preview, err := f.manager.Inspect(t.Context(), "admin", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if preview.Files < 2 {
		t.Fatal(preview)
	}
	if _, err = f.manager.StartRestore("someone-else", preview.ID); !errors.Is(err, backup.ErrStage) {
		t.Fatal("accepted foreign upload", err)
	}
	if _, err = f.manager.StartRestore("admin", preview.ID); err != nil {
		t.Fatal(err)
	}
	job := waitJob(t, f.manager)
	if job.Status != "succeeded" || job.RecoveryFile == "" {
		t.Fatal(job)
	}
	var title string
	f.db.QueryRow(`SELECT title FROM maps`).Scan(&title)
	if title != "original" {
		t.Fatal(title)
	}
	image, _ := os.ReadFile(filepath.Join(f.uploads, "image.png"))
	if string(image) != "original-image" {
		t.Fatal(string(image))
	}
	if _, err = os.Stat(filepath.Join(f.uploads, "extra.png")); !os.IsNotExist(err) {
		t.Fatal("extra current file survived", err)
	}
	if _, err = os.Stat(filepath.Join(f.work, job.RecoveryFile)); err != nil {
		t.Fatal("no safety snapshot", err)
	}
	if _, err = f.auth.Authenticate(t.Context(), f.oldToken); err == nil {
		t.Fatal("old access session survived restore")
	}
	if _, err = f.manager.StartRestore("admin", preview.ID); !errors.Is(err, backup.ErrStage) {
		t.Fatal("restore token replay", err)
	}
	var stored string
	f.db.QueryRow(`SELECT value FROM settings WHERE key='backup.config'`).Scan(&stored)
	if strings.Contains(stored, "private-password") {
		t.Fatal("credentials stored in clear")
	}
	if f.manager.State().Configuration.WebDAV.Password != "" {
		t.Fatal("credentials exposed")
	}
}
func TestManagerMutualExclusionFailureAndCancellation(t *testing.T) {
	f := newManagerFixture(t)
	f.remote.block = make(chan struct{})
	f.remote.entered = make(chan struct{})
	if _, err := f.manager.StartBackup("manual"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.StartBackup("manual"); !errors.Is(err, backup.ErrBusy) {
		t.Fatal("parallel backup accepted", err)
	}
	if err := f.manager.Save(t.Context(), backup.DefaultConfiguration(), nil); !errors.Is(err, backup.ErrBusy) {
		t.Fatal("config changed during backup", err)
	}
	select {
	case <-f.remote.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not start")
	}
	f.cancel()
	job := waitJob(t, f.manager)
	if job.Status != "failed" || job.ErrorCode != "UPLOAD_FAILED" {
		t.Fatal(job)
	}
	if f.manager.State().Busy {
		t.Fatal("busy flag leaked")
	}
}
func TestManagerInvalidUploadNeverChangesData(t *testing.T) {
	f := newManagerFixture(t)
	if _, err := f.manager.Inspect(t.Context(), "admin", strings.NewReader("not-a-zip")); err == nil {
		t.Fatal("accepted invalid zip")
	}
	var title string
	f.db.QueryRow(`SELECT title FROM maps`).Scan(&title)
	if title != "original" {
		t.Fatal("changed DB during inspection")
	}
	entries, err := os.ReadDir(f.work)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "stage-") {
			t.Fatal("failed stage not removed")
		}
	}
}
func TestSchedulerMinuteDeduplicationAndDisabledState(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.Cron = "* * * * *"
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 24, 8, 0, 0, 0, time.UTC)
	f.manager.Tick(now)
	waitJob(t, f.manager)
	f.manager.Tick(now.Add(30 * time.Second))
	f.manager.Wait()
	f.remote.mu.Lock()
	count := f.remote.count
	f.remote.mu.Unlock()
	if count != 1 {
		t.Fatal("duplicate minute", count)
	}
	c.Enabled = false
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	f.manager.Tick(now.Add(time.Minute))
	f.manager.Wait()
	f.remote.mu.Lock()
	defer f.remote.mu.Unlock()
	if f.remote.count != 1 {
		t.Fatal("disabled scheduler ran")
	}
}

func TestManagerRejectsUploadsContainingDatabase(t *testing.T) {
	f := newManagerFixture(t)
	root := filepath.Dir(f.uploads)
	var database string
	if err := f.db.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&database); err != nil {
		t.Fatal(err)
	}
	_, err := backup.NewManager(t.Context(), backup.ManagerConfig{
		Repository: sqlite.NewBackupRepository(f.db), Settings: sqlite.NewSettingsRepository(f.db),
		UploadDir: root, WorkDir: filepath.Join(t.TempDir(), "work"), Secret: strings.Repeat("s", 32),
		ProtectedPaths: []string{database},
	})
	if err == nil {
		t.Fatal("accepted uploads containing the live database; restore could move it")
	}
}

func TestManagerReclaimsExpiredOwnedStagingOnly(t *testing.T) {
	f := newManagerFixture(t)
	stale := filepath.Join(f.work, "stage-12345")
	fresh := filepath.Join(f.work, "stage-12346")
	unrelated := filepath.Join(f.work, "stage-manual")
	for _, dir := range []string{stale, fresh, unrelated} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-2 * time.Hour)
	os.Chtimes(stale, past, past)
	os.Chtimes(unrelated, past, past)
	_, err := backup.NewManager(t.Context(), backup.ManagerConfig{Repository: sqlite.NewBackupRepository(f.db), Settings: sqlite.NewSettingsRepository(f.db), UploadDir: f.uploads, WorkDir: f.work, Secret: strings.Repeat("s", 32)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("expired staging survived restart")
	}
	for _, dir := range []string{fresh, unrelated} {
		if _, err = os.Stat(dir); err != nil {
			t.Fatal("removed fresh or unrelated directory", err)
		}
	}
}

func TestLaunchReturnsImmutableInitialJob(t *testing.T) {
	f := newManagerFixture(t)
	for range 25 {
		job, err := f.manager.StartBackup("manual")
		if err != nil {
			t.Fatal(err)
		}
		if job.Status != "running" || job.Stage != "preparing" || job.FinishedAt != nil {
			t.Fatalf("launch response was mutated by worker: %+v", job)
		}
		f.manager.Wait()
		if job.Status != "running" || job.Stage != "preparing" {
			t.Fatal("returned snapshot changed")
		}
	}
}
