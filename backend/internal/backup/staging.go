package backup

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Called only at startup or while the job mutex is held. Never remove an active
// capture/restore, recovery ZIP, or an administrator's unrelated directory.
func (m *Manager) reclaimStaging(now time.Time) {
	m.mu.Lock()
	for id, stage := range m.staged {
		if now.After(stage.preview.ExpiresAt) {
			_ = os.RemoveAll(stage.dir)
			delete(m.staged, id)
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
		info, err := entry.Info()
		if err != nil || !info.ModTime().Before(now.Add(-time.Hour)) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(m.cfg.WorkDir, entry.Name()))
	}
}
