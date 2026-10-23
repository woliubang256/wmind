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
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
)

type remoteStub struct {
	mu      sync.Mutex
	data    []byte
	block   chan struct{}
	entered chan struct{}
	fail    bool
	count   int
}

func (r *remoteStub) Test(context.Context, backup.Configuration) error { return nil }
func (r *remoteStub) Upload(ctx context.Context, _ backup.Configuration, _, filename string) error {
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
