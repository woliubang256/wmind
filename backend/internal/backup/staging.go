package backup

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Called only while the cross-process job reservation is held. Never remove an active
// capture/restore, recovery ZIP, or an administrator's unrelated directory.
func (m *Manager) reclaimStaging(now time.Time) {
	m.mu.Lock()
	active := make(map[string]bool)
	for id, stage := range m.staged {
		if !now.Before(stage.preview.ExpiresAt) {
			_ = os.RemoveAll(stage.dir)
			delete(m.staged, id)
		} else {
			active[stage.dir] = true
		}
	}
	m.mu.Unlock()
	entries, err := os.ReadDir(m.cfg.WorkDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		prefix, suffix, ok := strings.Cut(entry.Name(), "-")
		if !ok || (prefix != "stage" && prefix != "capture" && prefix != "before") {
			continue
		}
		if _, err := strconv.ParseUint(suffix, 10, 32); err != nil {
			continue
		}
		dir := filepath.Join(m.cfg.WorkDir, entry.Name())
		if active[dir] {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		eligible := info.ModTime().Before(now.Add(-time.Hour))
		if prefix == "stage" {
			eligible = stageExpired(dir, eligible, now)
		}
		if eligible {
			_ = os.RemoveAll(dir)
		}
	}
	m.reclaimRestoreStaging(now)
}

// A preview's expiry starts after extraction, not when MkdirTemp ran. The
// small marker also protects previews owned by another server process.
func stageExpired(dir string, legacyExpired bool, now time.Time) bool {
	path := filepath.Join(dir, "preview-expires-at")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return legacyExpired
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 128 {
		return false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	expires, err := time.Parse(time.RFC3339Nano, string(raw))
	if err != nil {
		// An interrupted marker cannot describe a usable preview. All Inspect
		// operations are excluded by the shared job reservation at this point.
		return legacyExpired
	}
	return !now.Before(expires)
}

func writePreviewExpiry(dir string, expires time.Time) error {
	f, err := os.CreateTemp(dir, ".preview-expiry-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.WriteString(expires.Format(time.RFC3339Nano))
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, "preview-expires-at"))
}

var restoreJobID = regexp.MustCompile(`^[A-Z2-7]{26}$`)

func (m *Manager) restorePrefix(kind string) string {
	return "." + filepath.Base(m.cfg.UploadDir) + "-wmind-restore-" + kind + "-"
}

func (m *Manager) reclaimRestoreStaging(now time.Time) {
	resume, ok, err := m.cfg.Gate.TryPause()
	if err != nil || !ok {
		return
	}
	defer resume()
	// Missing live uploads may indicate an interrupted restore. Preserve all
	// sibling copies until the operator has recovered the installation.
	info, err := os.Lstat(m.cfg.UploadDir)
	if err != nil || !info.IsDir() {
		return
	}
	parent := filepath.Dir(m.cfg.UploadDir)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return
	}
	attempted := 0
	for _, entry := range entries {
		if !entry.IsDir() || attempted >= 100 {
			continue
		}
		name := entry.Name()
		next := strings.TrimPrefix(name, m.restorePrefix("next"))
		garbage := strings.TrimPrefix(name, m.restorePrefix("garbage"))
		switch {
		case next != name:
			if _, err := strconv.ParseUint(next, 10, 32); err != nil {
				continue
			}
			info, err := entry.Info()
			if err != nil || !info.ModTime().Before(now.Add(-time.Hour)) {
				continue
			}
		case garbage != name && restoreJobID.MatchString(garbage):
			// This name is assigned only after Repository.Restore commits.
		default:
			continue
		}
		attempted++
		if err := os.RemoveAll(filepath.Join(parent, name)); err != nil {
			m.cfg.Logger.Warn("restore staging cleanup will be retried")
		}
	}
}
