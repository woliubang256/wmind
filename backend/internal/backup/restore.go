package backup

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

type RestorePreview struct {
	ID        string                `json:"id"`
	CreatedAt time.Time             `json:"createdAt"`
	Database  domain.BackupIdentity `json:"database"`
	Files     int                   `json:"files"`
	Bytes     int64                 `json:"bytes"`
	ExpiresAt time.Time             `json:"expiresAt"`
}
type stagedRestore struct {
	preview RestorePreview
	dir     string
	owner   string
}

func (m *Manager) Inspect(ctx context.Context, owner string, reader io.Reader) (RestorePreview, error) {
	if !m.reserve() {
		return RestorePreview{}, ErrBusy
	}
	defer m.release()
	m.reclaimStaging(time.Now())
	// One staged upload per admin; expired stages are reclaimed when uploading.
	m.mu.Lock()
	for key, stage := range m.staged {
		if stage.owner == owner || time.Now().After(stage.preview.ExpiresAt) {
			os.RemoveAll(stage.dir)
			delete(m.staged, key)
		}
	}
	m.mu.Unlock()
	dir, err := os.MkdirTemp(m.cfg.WorkDir, "stage-")
	if err != nil {
		return RestorePreview{}, err
	}
	keep := false
	defer func() {
		if !keep {
			os.RemoveAll(dir)
		}
	}()
	archive := filepath.Join(dir, "upload.zip")
	f, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return RestorePreview{}, err
	}
	n, err := io.Copy(f, io.LimitReader(reader, MaxZIPBytes+1))
	err = errors.Join(err, f.Close())
	if err != nil {
		return RestorePreview{}, err
	}
	if n > MaxZIPBytes {
		return RestorePreview{}, errors.New("ZIP exceeds 2 GiB")
	}
	id, err := m.cfg.Repository.Identity(ctx)
	if err != nil {
		return RestorePreview{}, err
	}
	content := filepath.Join(dir, "content")
	manifest, err := Unpack(ctx, archive, content, id, KeyID(m.cfg.Secret))
	if err != nil {
		return RestorePreview{}, err
	}
	if err = m.cfg.Repository.Validate(ctx, content); err != nil {
		return RestorePreview{}, err
	}
	preview := RestorePreview{ID: rand.Text(), CreatedAt: manifest.CreatedAt, Database: id, Files: len(manifest.Files), Bytes: n, ExpiresAt: time.Now().Add(time.Hour).UTC()}
	m.mu.Lock()
	m.staged[preview.ID] = stagedRestore{preview: preview, dir: dir, owner: owner}
	m.mu.Unlock()
	keep = true
	return preview, nil
}
func (m *Manager) StartRestore(owner, token string) (Job, error) {
	if !m.reserve() {
		return Job{}, ErrBusy
	}
	m.mu.Lock()
	staged, ok := m.staged[token]
	if !ok || staged.owner != owner || time.Now().After(staged.preview.ExpiresAt) {
		m.mu.Unlock()
		m.release()
		return Job{}, ErrStage
	}
	delete(m.staged, token)
	m.mu.Unlock()
	return m.launch("restore", "manual", func(ctx context.Context, job *Job) error {
		defer os.RemoveAll(staged.dir)
		return m.restore(ctx, job, staged)
	}), nil
}
func (m *Manager) restore(ctx context.Context, job *Job, stage stagedRestore) error {
	id, err := m.cfg.Repository.Identity(ctx)
	if err != nil {
		return err
	}
	if id != stage.preview.Database {
		job.ErrorCode = "INCOMPATIBLE_ARCHIVE"
		return errors.New("database schema changed after upload")
	}
	// Stage files on the uploads filesystem so the eventual rename is local.
	next, err := os.MkdirTemp(filepath.Dir(m.cfg.UploadDir), ".wmind-restore-next-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(next)
	if err = CaptureFiles(ctx, filepath.Join(stage.dir, "content", "uploads"), next); err != nil {
		return err
	}
	resume := m.cfg.Gate.Pause()
	defer resume()
	m.stage(job, "safety_backup")
	dir, err := os.MkdirTemp(m.cfg.WorkDir, "before-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	manifest, err := m.capture(ctx, dir)
	if err != nil {
		job.ErrorCode = "SAFETY_BACKUP_FAILED"
		return err
	}
	archiveName := "before-restore-" + job.StartedAt.Format("20060102T150405Z") + "-" + job.ID[:8] + ".zip"
	if _, err = Pack(ctx, dir, filepath.Join(m.cfg.WorkDir, archiveName), manifest); err != nil {
		job.ErrorCode = "SAFETY_BACKUP_FAILED"
		return err
	}
	job.RecoveryFile = archiveName
	m.stage(job, "restoring")
	old := filepath.Join(filepath.Dir(m.cfg.UploadDir), ".wmind-restore-old-"+job.ID)
	install := func() (func() error, error) {
		if err := os.Rename(m.cfg.UploadDir, old); err != nil {
			return nil, err
		}
		if err := os.Rename(next, m.cfg.UploadDir); err != nil {
			return nil, errors.Join(err, os.Rename(old, m.cfg.UploadDir))
		}
		return func() error {
			if err := os.Rename(m.cfg.UploadDir, next); err != nil {
				return err
			}
			return os.Rename(old, m.cfg.UploadDir)
		}, nil
	}
	if err = m.cfg.Repository.Restore(ctx, filepath.Join(stage.dir, "content"), install); err != nil {
		job.ErrorCode = "RESTORE_FAILED"
		return err
	}
	// Once committed, never remove live data to retry an application cache reload.
	os.RemoveAll(old)
	m.stage(job, "reloading")
	if m.cfg.AfterRestore != nil {
		if err = m.cfg.AfterRestore(ctx); err != nil {
			job.ErrorCode = "RESTORE_RELOAD_FAILED"
			return err
		}
	}
	// Remote ownership belongs to this installation, not the old DB snapshot.
	// Revoke cached sessions above even if persisting this ledger fails.
	m.mu.Lock()
	objects := append([]backupObject{}, m.catalog...)
	for i := range objects {
		objects[i].Fingerprint = ""
	}
	m.catalog = objects
	m.mu.Unlock()
	if err = m.saveCatalog(ctx, objects); err != nil {
		job.ErrorCode = "RESTORE_RELOAD_FAILED"
		return err
	}
	if err = m.Reload(ctx); err != nil {
		job.ErrorCode = "RESTORE_RELOAD_FAILED"
		return err
	}
	return nil
}
