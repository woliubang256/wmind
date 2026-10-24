package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"strings"
	"time"
)

// This operational ledger is independent of the bounded display history.
type backupObject struct {
	Target      string    `json:"target"`
	Filename    string    `json:"filename"`
	CreatedAt   time.Time `json:"createdAt"`
	Fingerprint string    `json:"fingerprint,omitempty"`
}

func targetID(c Configuration) string {
	address := func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return raw
		}
		u.Host = strings.ToLower(u.Host)
		u.Path = strings.TrimRight(u.Path, "/")
		u.RawPath = ""
		return u.String()
	}
	var identity any
	if c.Target == "webdav" {
		identity = []string{c.Target, address(c.WebDAV.URL), c.WebDAV.Username}
	} else {
		identity = []any{c.Target, address(c.S3.Endpoint), c.S3.Region, c.S3.Bucket, path.Clean(c.S3.Prefix), c.S3.AccessKey, c.S3.PathStyle}
	}
	raw, _ := json.Marshal(identity)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func decodeCatalog(raw string) ([]backupObject, error) {
	var objects []backupObject
	if err := json.Unmarshal([]byte(raw), &objects); err != nil {
		return nil, errors.New("invalid backup catalog")
	}
	seen := map[string]bool{}
	for _, object := range objects {
		target, err := hex.DecodeString(object.Target)
		key := object.Target + ":" + object.Filename
		if err != nil || len(target) != sha256.Size || !backupObjectName.MatchString(object.Filename) || seen[key] {
			return nil, errors.New("invalid backup catalog entry")
		}
		seen[key] = true
	}
	return objects, nil
}

func (m *Manager) saveCatalog(ctx context.Context, objects []backupObject) error {
	raw, err := json.Marshal(objects)
	if err != nil {
		return err
	}
	if err = m.cfg.Settings.Upsert(ctx, "backup.catalog", string(raw), nil, time.Now().UTC()); err != nil {
		return err
	}
	m.mu.Lock()
	m.catalog = append([]backupObject{}, objects...)
	m.mu.Unlock()
	return nil
}

func (m *Manager) recordBackup(ctx context.Context, job *Job, c Configuration, fingerprint string) {
	m.mu.RLock()
	objects := append([]backupObject{}, m.catalog...)
	m.mu.RUnlock()
	object := backupObject{Target: targetID(c), Filename: job.Filename, CreatedAt: time.Now().UTC(), Fingerprint: fingerprint}
	objects = append([]backupObject{object}, objects...)
	if err := m.saveCatalog(ctx, objects); err != nil {
		job.WarningCode = "CATALOG_FAILED"
		return // Never delete older copies until the new object is durably registered.
	}
	m.pruneBackups(ctx, job, c)
}

func (m *Manager) pruneBackups(ctx context.Context, job *Job, c Configuration) {
	m.mu.RLock()
	objects := append([]backupObject{}, m.catalog...)
	m.mu.RUnlock()
	target, count := targetID(c), 0
	kept := make([]backupObject, 0, len(objects))
	for _, object := range objects {
		if object.Target != target {
			kept = append(kept, object)
			continue
		}
		count++
		if count <= c.RetainCount {
			kept = append(kept, object)
			continue
		}
		if err := m.cfg.Remote.Delete(ctx, c, object.Filename); err != nil {
			job.WarningCode = "CLEANUP_FAILED"
			kept = append(kept, object)
		}
	}
	if len(kept) != len(objects) {
		if err := m.saveCatalog(ctx, kept); err != nil {
			job.WarningCode = "CATALOG_FAILED"
		}
	}
}
