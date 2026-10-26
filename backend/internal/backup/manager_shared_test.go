package backup_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/backup"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

func anotherManager(t *testing.T, f *managerFixture, settings domain.SettingsRepo) *backup.Manager {
	t.Helper()
	if settings == nil {
		settings = sqlite.NewSettingsRepository(f.db)
	}
	m, err := backup.NewManager(f.ctx, backup.ManagerConfig{
		Repository: sqlite.NewBackupRepository(f.db), Settings: settings,
		UploadDir: f.uploads, WorkDir: f.work, Secret: strings.Repeat("s", 32),
		Remote: f.remote, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Wait)
	return m
}

func TestSharedManagersRetainAllBackupRegistrations(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.RetainCount = 1
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	second := anotherManager(t, f, nil) // Its catalog is empty when first starts.
	first := runBackup(t, f, "manual")
	if first.Status != "succeeded" {
		t.Fatal(first)
	}
	f.manager = second
	latest := runBackup(t, f, "manual")
	if latest.Status != "succeeded" {
		t.Fatal(latest)
	}
	if len(f.remote.objects) != 1 || f.remote.objects[first.Filename] || !f.remote.objects[latest.Filename] {
		t.Fatalf("older registered copy became an untracked remote orphan: objects=%d deleted=%v", len(f.remote.objects), f.remote.deleted)
	}
	if len(second.State().History) != 2 {
		t.Fatalf("other manager's completed history was lost: %d", len(second.State().History))
	}
}

func TestSharedManagersReadLatestDeduplicationSetting(t *testing.T) {
	f := newManagerFixture(t)
	second := anotherManager(t, f, nil)
	c := f.manager.State().Configuration
	c.SkipUnchanged = true
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	first := runBackup(t, f, "manual")
	f.manager = second
	next := runBackup(t, f, "manual")
	if first.Status != "succeeded" || next.Status != "skipped" || f.remote.count != 1 {
		t.Fatalf("stale configuration/catalog caused duplicate upload: first=%s next=%s uploads=%d", first.Status, next.Status, f.remote.count)
	}
}

func TestSharedManagerTickUsesCurrentEnabledSetting(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.Cron = "* * * * *"
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	second := anotherManager(t, f, nil)
	c.Enabled = false
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	second.Tick(time.Now())
	second.Wait()
	if f.remote.count != 0 {
		t.Fatal("another manager's disabled schedule still uploaded a backup")
	}
	if second.State().Configuration.Enabled {
		t.Fatal("tick did not refresh the configuration")
	}
}

func TestSharedManagerSavePreservesLatestCredentials(t *testing.T) {
	f := newManagerFixture(t)
	second := anotherManager(t, f, nil)
	c := f.manager.State().Configuration
	c.WebDAV.Password = "updated-test-password"
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	staleForm := second.State().Configuration
	staleForm.RetainCount = 12
	if err := second.Save(t.Context(), staleForm, nil); err != nil {
		t.Fatal(err)
	}
	rows, err := sqlite.NewSettingsRepository(f.db).List(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	box, err := backup.NewSecretBox(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Key != "backup.config" {
			continue
		}
		stored, err := box.Open(row.Value)
		if err != nil {
			t.Fatal(err)
		}
		if stored.WebDAV.Password != c.WebDAV.Password || stored.RetainCount != 12 {
			t.Fatal("saving a redacted form restored outdated remote credentials")
		}
		return
	}
	t.Fatal("configuration missing")
}

var errBackupStateRead = errors.New("backup state unavailable")

type failLatestSettings struct {
	domain.SettingsRepo
	fail atomic.Bool
}

func (s *failLatestSettings) List(ctx context.Context) ([]*domain.Setting, error) {
	if s.fail.Load() {
		return nil, errBackupStateRead
	}
	return s.SettingsRepo.List(ctx)
}

func TestBackupOperationsRejectUnreadableLatestState(t *testing.T) {
	for _, operation := range []string{"backup", "save", "test", "inspect", "restore"} {
		t.Run(operation, func(t *testing.T) {
			f := newManagerFixture(t)
			settings := &failLatestSettings{SettingsRepo: sqlite.NewSettingsRepository(f.db)}
			m := anotherManager(t, f, settings)
			settings.fail.Store(true)
			var err error
			switch operation {
			case "backup":
				_, err = m.StartBackup("manual")
			case "save":
				err = m.Save(t.Context(), m.State().Configuration, nil)
			case "test":
				err = m.Test(t.Context(), m.State().Configuration)
			case "inspect":
				_, err = m.Inspect(t.Context(), "admin", strings.NewReader("invalid zip"))
			case "restore":
				_, err = m.StartRestore("admin", "missing-preview")
			}
			m.Wait()
			if !errors.Is(err, errBackupStateRead) {
				t.Fatalf("latest state error replaced with stale operation result: %v", err)
			}
			if m.State().Busy || f.remote.count != 0 {
				t.Fatal("failed reload retained lock or started upload")
			}
			settings.fail.Store(false)
			if err := m.Test(t.Context(), m.State().Configuration); err != nil {
				t.Fatalf("lock not released after reload failure: %v", err)
			}
		})
	}
}

func TestBackupTickSkipsUnreadableLatestStateAndReleasesReservation(t *testing.T) {
	f := newManagerFixture(t)
	c := f.manager.State().Configuration
	c.Cron = "* * * * *"
	if err := f.manager.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	settings := &failLatestSettings{SettingsRepo: sqlite.NewSettingsRepository(f.db)}
	m := anotherManager(t, f, settings)
	settings.fail.Store(true)
	now := time.Now()
	m.Tick(now)
	m.Wait()
	if m.State().Busy || f.remote.count != 0 {
		t.Fatal("unreadable schedule ran or retained the job lock")
	}
	settings.fail.Store(false)
	m.Tick(now.Add(time.Minute))
	m.Wait()
	if f.remote.count != 1 {
		t.Fatal("scheduler did not recover on the next minute")
	}
}
