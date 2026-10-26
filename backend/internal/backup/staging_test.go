package backup

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func stagingManager(t *testing.T) *Manager {
	t.Helper()
	root := t.TempDir()
	uploads, work := filepath.Join(root, "uploads"), filepath.Join(root, "work")
	for _, path := range []string{uploads, work} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return &Manager{cfg: ManagerConfig{UploadDir: uploads, WorkDir: work, Gate: &Gate{}, Logger: slog.Default()}, staged: map[string]stagedRestore{}}
}

func stageDirectory(t *testing.T, path string, at time.Time) {
	t.Helper()
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "payload"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func TestReclaimRestoreStagingPreservesRecoveryAndOtherInstallations(t *testing.T) {
	m := stagingManager(t)
	now := time.Now()
	parent := filepath.Dir(m.cfg.UploadDir)
	for _, tc := range []struct {
		name string
		age  time.Duration
	}{
		{".uploads-wmind-restore-next-12345", 2 * time.Hour},
		{".uploads-wmind-restore-next-12346", time.Minute},
		{".uploads-wmind-restore-garbage-ABCDEFGHIJKLMNOPQRSTUVWXYZ", 2 * time.Hour},
		{".uploads-wmind-restore-old-ABCDEFGHIJKLMNOPQRSTUVWXYZ", 2 * time.Hour},
		{".other-wmind-restore-next-12345", 2 * time.Hour},
		{".uploads-wmind-restore-next-manual", 2 * time.Hour},
		{".wmind-restore-old-ABCDEFGHIJKLMNOPQRSTUVWXYZ", 2 * time.Hour},
	} {
		stageDirectory(t, filepath.Join(parent, tc.name), now.Add(-tc.age))
	}
	outside := t.TempDir()
	link := filepath.Join(parent, ".uploads-wmind-restore-next-12347")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	m.reclaimStaging(now)
	for _, name := range []string{".uploads-wmind-restore-next-12345", ".uploads-wmind-restore-garbage-ABCDEFGHIJKLMNOPQRSTUVWXYZ"} {
		if _, err := os.Lstat(filepath.Join(parent, name)); !os.IsNotExist(err) {
			t.Errorf("orphan %s remains: %v", name, err)
		}
	}
	for _, name := range []string{".uploads-wmind-restore-next-12346", ".uploads-wmind-restore-old-ABCDEFGHIJKLMNOPQRSTUVWXYZ", ".other-wmind-restore-next-12345", ".uploads-wmind-restore-next-manual", ".wmind-restore-old-ABCDEFGHIJKLMNOPQRSTUVWXYZ", ".uploads-wmind-restore-next-12347"} {
		if _, err := os.Lstat(filepath.Join(parent, name)); err != nil {
			t.Errorf("protected %s removed: %v", name, err)
		}
	}
}

func TestReclaimStagingHonorsPreviewExpiryInsteadOfDirectoryAge(t *testing.T) {
	m := stagingManager(t)
	now := time.Now()
	for _, suffix := range []string{"12345", "12346"} {
		dir := filepath.Join(m.cfg.WorkDir, "stage-"+suffix)
		stageDirectory(t, dir, now.Add(-2*time.Hour))
		if suffix == "12345" {
			m.staged["active"] = stagedRestore{dir: dir, preview: RestorePreview{ExpiresAt: now.Add(time.Minute)}}
		} else {
			if err := os.WriteFile(filepath.Join(dir, "preview-expires-at"), []byte(now.Add(time.Minute).Format(time.RFC3339Nano)), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(dir, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
	}
	m.reclaimStaging(now)
	for _, suffix := range []string{"12345", "12346"} {
		if _, err := os.Stat(filepath.Join(m.cfg.WorkDir, "stage-"+suffix)); err != nil {
			t.Errorf("unexpired preview %s removed: %v", suffix, err)
		}
	}
}

func TestReclaimStagingRecoversInterruptedExpiryMarker(t *testing.T) {
	m := stagingManager(t)
	now := time.Now()
	for i, content := range []string{"", "2026-10-26T"} {
		dir := filepath.Join(m.cfg.WorkDir, []string{"stage-12345", "stage-12346"}[i])
		stageDirectory(t, dir, now.Add(-2*time.Hour))
		if err := os.WriteFile(filepath.Join(dir, "preview-expires-at"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(dir, now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	m.reclaimStaging(now)
	for _, name := range []string{"stage-12345", "stage-12346"} {
		if _, err := os.Stat(filepath.Join(m.cfg.WorkDir, name)); !os.IsNotExist(err) {
			t.Errorf("interrupted marker retained abandoned %s", name)
		}
	}
}

func TestBackupJobReservationCoordinatesSharedWorkDirectory(t *testing.T) {
	m := stagingManager(t)
	other := &Manager{cfg: m.cfg}
	if !m.reserve() {
		t.Fatal("first reservation failed")
	}
	if other.reserve() {
		other.release()
		t.Error("second process entered shared staging while a job is active")
	}
	m.release()
	if !other.reserve() {
		t.Fatal("reservation did not recover after release")
	}
	other.release()
}

func TestReclaimRestoreStagingRequiresIdleGateAndLiveUploads(t *testing.T) {
	m := stagingManager(t)
	now := time.Now()
	orphan := filepath.Join(filepath.Dir(m.cfg.UploadDir), ".uploads-wmind-restore-next-12345")
	stageDirectory(t, orphan, now.Add(-2*time.Hour))
	leave, ok := m.cfg.Gate.Enter()
	if !ok {
		t.Fatal("enter gate")
	}
	m.reclaimStaging(now)
	if _, err := os.Stat(orphan); err != nil {
		t.Fatalf("active request lost staging: %v", err)
	}
	leave()
	if err := os.Remove(m.cfg.UploadDir); err != nil {
		t.Fatal(err)
	}
	m.reclaimStaging(now)
	if _, err := os.Stat(orphan); err != nil {
		t.Fatalf("missing live uploads lost recovery staging: %v", err)
	}
}

func TestBackupJobLockFailureDoesNotRunUncoordinated(t *testing.T) {
	m := stagingManager(t)
	path := filepath.Join(m.cfg.WorkDir, ".jobs.lock")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if m.reserve() {
		m.release()
		t.Fatal("job ran without a usable file lock")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if !m.reserve() {
		t.Fatal("local mutex was retained after lock failure")
	}
	m.release()
}
