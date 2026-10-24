package backup

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

var ErrBusy = errors.New("backup operation already in progress")
var ErrStage = errors.New("restore upload expired or belongs to another user")

type Job struct {
	ID             string     `json:"id"`
	Kind           string     `json:"kind"`
	Trigger        string     `json:"trigger"`
	Status         string     `json:"status"`
	Stage          string     `json:"stage"`
	StartedAt      time.Time  `json:"startedAt"`
	FinishedAt     *time.Time `json:"finishedAt,omitempty"`
	Filename       string     `json:"filename,omitempty"`
	Bytes          int64      `json:"bytes,omitempty"`
	ErrorCode      string     `json:"errorCode,omitempty"`
	WarningCode    string     `json:"warningCode,omitempty"`
	ContentVersion string     `json:"contentVersion,omitempty"`
	RecoveryFile   string     `json:"recoveryFile,omitempty"`
}
type State struct {
	Configuration  Configuration `json:"configuration"`
	NextRuns       []time.Time   `json:"nextRuns"`
	Current        *Job          `json:"current,omitempty"`
	History        []Job         `json:"history"`
	Busy           bool          `json:"busy"`
	MaxUploadBytes int64         `json:"maxUploadBytes"`
}
type ManagerConfig struct {
	ProtectedPaths []string
	Repository     domain.BackupRepository
	Settings       domain.SettingsRepo
	UploadDir      string
	WorkDir        string
	Secret         string
	Remote         Remote
	Gate           *Gate
	AfterRestore   func(context.Context) error
	Logger         *slog.Logger
}
type Manager struct {
	cfg           ManagerConfig
	ctx           context.Context
	box           *SecretBox
	mu            sync.RWMutex
	configuration Configuration
	history       []Job
	catalog       []backupObject
	current       *Job
	staged        map[string]stagedRestore
	jobMu         sync.Mutex
	running       atomic.Bool
	wg            sync.WaitGroup
	tickMu        sync.Mutex
	lastTick      time.Time
}

func NewManager(ctx context.Context, cfg ManagerConfig) (*Manager, error) {
	if cfg.Repository == nil || cfg.Settings == nil || cfg.UploadDir == "" {
		return nil, errors.New("backup repository, settings and uploads required")
	}
	var err error
	cfg.UploadDir, err = filepath.Abs(cfg.UploadDir)
	if err != nil {
		return nil, err
	}
	if resolved, e := filepath.EvalSymlinks(cfg.UploadDir); e == nil {
		cfg.UploadDir = resolved
	}
	for _, protected := range cfg.ProtectedPaths {
		absolute, e := filepath.Abs(protected)
		if e != nil {
			return nil, e
		}
		if resolved, e := filepath.EvalSymlinks(absolute); e == nil {
			absolute = resolved
		}
		relative, e := filepath.Rel(cfg.UploadDir, absolute)
		if e != nil || relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))) {
			return nil, errors.New("uploads directory must not contain a live database file")
		}
	}
	if cfg.WorkDir == "" {
		cfg.WorkDir = filepath.Join(filepath.Dir(cfg.UploadDir), ".wmind-backups")
	}
	cfg.WorkDir, err = filepath.Abs(cfg.WorkDir)
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(cfg.UploadDir, cfg.WorkDir)
	if err != nil || rel == "." || (!strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && rel != "..") {
		return nil, errors.New("backup work directory must be outside uploads")
	}
	if cfg.Remote == nil {
		cfg.Remote = NewRemoteStorage()
	}
	if cfg.Gate == nil {
		cfg.Gate = &Gate{}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	box, err := NewSecretBox(cfg.Secret)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(cfg.WorkDir, 0700); err != nil {
		return nil, err
	}
	m := &Manager{cfg: cfg, ctx: ctx, box: box, configuration: DefaultConfiguration(), history: []Job{}, staged: make(map[string]stagedRestore)}
	if err = m.Reload(ctx); err != nil {
		return nil, err
	}
	m.reclaimStaging(time.Now())
	return m, nil
}
func (m *Manager) Gate() *Gate { return m.cfg.Gate }
func (m *Manager) Reload(ctx context.Context) error {
	rows, err := m.cfg.Settings.List(ctx)
	if err != nil {
		return err
	}
	configuration := DefaultConfiguration()
	history := []Job{}
	catalog := []backupObject{}
	for _, row := range rows {
		switch row.Key {
		case "backup.config":
			configuration, err = m.box.Open(row.Value)
			if err != nil {
				return err
			}
			if err = configuration.Validate(configuration.Enabled); err != nil {
				return err
			}
		case "backup.history":
			if err = json.Unmarshal([]byte(row.Value), &history); err != nil {
				return errors.New("invalid backup history")
			}
		case "backup.catalog":
			if catalog, err = decodeCatalog(row.Value); err != nil {
				return err
			}
		}
	}
	if len(history) > 20 {
		history = history[:20]
	}
	m.mu.Lock()
	m.configuration = configuration
	m.history = history
	m.catalog = catalog
	m.mu.Unlock()
	return nil
}
func (m *Manager) State() State {
	m.mu.RLock()
	defer m.mu.RUnlock()
	next, _ := Schedule(m.configuration.Cron, m.configuration.Timezone, time.Now())
	if next == nil {
		next = []time.Time{}
	}
	state := State{Configuration: m.configuration.Public(), NextRuns: next, History: append([]Job{}, m.history...), Busy: m.running.Load(), MaxUploadBytes: MaxZIPBytes}
	if m.current != nil {
		job := *m.current
		state.Current = &job
	}
	return state
}
func (m *Manager) reserve() bool {
	if !m.jobMu.TryLock() {
		return false
	}
	m.running.Store(true)
	return true
}
func (m *Manager) release() { m.running.Store(false); m.jobMu.Unlock() }
func (m *Manager) Save(ctx context.Context, input Configuration, actor *int64) error {
	if !m.reserve() {
		return ErrBusy
	}
	defer m.release()
	m.mu.RLock()
	input = input.WithSecrets(m.configuration)
	m.mu.RUnlock()
	if err := input.Validate(input.Enabled); err != nil {
		return err
	}
	value, err := m.box.Seal(input)
	if err != nil {
		return err
	}
	if err = m.cfg.Settings.Upsert(ctx, "backup.config", value, actor, time.Now().UTC()); err != nil {
		return err
	}
	m.mu.Lock()
	m.configuration = input
	m.mu.Unlock()
	return nil
}
func (m *Manager) Test(ctx context.Context, input Configuration) error {
	if !m.reserve() {
		return ErrBusy
	}
	defer m.release()
	m.mu.RLock()
	input = input.WithSecrets(m.configuration)
	m.mu.RUnlock()
	testCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	return m.cfg.Remote.Test(testCtx, input)
}
func (m *Manager) StartBackup(trigger string) (Job, error) {
	if !m.reserve() {
		return Job{}, ErrBusy
	}
	m.mu.RLock()
	configuration := m.configuration
	m.mu.RUnlock()
	if err := configuration.Validate(true); err != nil {
		m.release()
		return Job{}, err
	}
	return m.launch("backup", trigger, func(ctx context.Context, job *Job) error { return m.backup(ctx, job, configuration) }), nil
}
func (m *Manager) launch(kind, trigger string, run func(context.Context, *Job) error) Job {
	job := Job{ID: rand.Text(), Kind: kind, Trigger: trigger, Status: "running", Stage: "preparing", StartedAt: time.Now().UTC()}
	m.update(job)
	m.wg.Add(1)
	go func(job Job) {
		defer m.wg.Done()
		defer m.release()
		ctx, cancel := context.WithTimeout(m.ctx, time.Hour)
		defer cancel()
		err := run(ctx, &job)
		done := time.Now().UTC()
		job.FinishedAt = &done
		if err != nil {
			job.Status = "failed"
			if job.ErrorCode == "" {
				job.ErrorCode = "OPERATION_FAILED"
			}
			m.cfg.Logger.Warn("backup operation failed", "kind", kind, "stage", job.Stage, "code", job.ErrorCode)
		} else if job.Status != "skipped" {
			job.Status = "succeeded"
			job.Stage = "completed"
		}
		m.mu.Lock()
		current := job
		m.current = &current
		m.history = append([]Job{job}, m.history...)
		if len(m.history) > 20 {
			m.history = m.history[:20]
		}
		raw, _ := json.Marshal(m.history)
		m.mu.Unlock()
		persistCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err = m.cfg.Settings.Upsert(persistCtx, "backup.history", string(raw), nil, time.Now().UTC()); err != nil {
			m.cfg.Logger.Warn("backup history persistence failed")
		}
	}(job)
	return job
}
func (m *Manager) update(job Job)               { m.mu.Lock(); copy := job; m.current = &copy; m.mu.Unlock() }
func (m *Manager) stage(job *Job, stage string) { job.Stage = stage; m.update(*job) }
func (m *Manager) Wait()                        { m.wg.Wait() }
func (m *Manager) capture(ctx context.Context, dir string) (Manifest, error) {
	id, err := m.cfg.Repository.Identity(ctx)
	if err != nil {
		return Manifest{}, err
	}
	if err = m.cfg.Repository.Export(ctx, dir); err != nil {
		return Manifest{}, err
	}
	if err = CaptureFiles(ctx, m.cfg.UploadDir, filepath.Join(dir, "uploads")); err != nil {
		return Manifest{}, err
	}
	return Manifest{Database: id, CreatedAt: time.Now().UTC(), KeyID: KeyID(m.cfg.Secret)}, nil
}
func (m *Manager) backup(ctx context.Context, job *Job, configuration Configuration) error {
	dir, err := os.MkdirTemp(m.cfg.WorkDir, "capture-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	m.stage(job, "capturing")
	var manifest Manifest
	func() {
		resume := m.cfg.Gate.Pause()
		defer resume()
		manifest, err = m.capture(ctx, filepath.Join(dir, "snapshot"))
	}()
	if err != nil {
		job.ErrorCode = "CAPTURE_FAILED"
		return err
	}
	m.stage(job, "checking")
	fingerprint, err := contentFingerprint(ctx, filepath.Join(dir, "snapshot"), manifest)
	if err != nil {
		job.ErrorCode = "CAPTURE_FAILED"
		return err
	}
	job.ContentVersion = fingerprint[:12]
	if configuration.SkipUnchanged {
		latest, same, err := m.unchanged(ctx, configuration, fingerprint)
		if err != nil {
			job.ErrorCode = "REMOTE_CHECK_FAILED"
			return err
		}
		if same {
			job.Status = "skipped"
			job.Stage = "completed"
			job.Filename = latest.Filename
			m.pruneBackups(ctx, job, configuration)
			return nil
		}
	}
	m.stage(job, "compressing")
	name := fmt.Sprintf("wmind-%s-%s.zip", job.StartedAt.Format("20060102T150405Z"), job.ID[:8])
	archive := filepath.Join(dir, name)
	if _, err = Pack(ctx, filepath.Join(dir, "snapshot"), archive, manifest); err != nil {
		job.ErrorCode = "ARCHIVE_FAILED"
		return err
	}
	stat, err := os.Stat(archive)
	if err != nil {
		return err
	}
	if stat.Size() > MaxZIPBytes {
		return errors.New("archive exceeds 2 GiB")
	}
	job.Bytes = stat.Size()
	job.Filename = name
	m.stage(job, "uploading")
	if err = m.cfg.Remote.Upload(ctx, configuration, name, archive); err != nil {
		job.ErrorCode = "UPLOAD_FAILED"
		return err
	}
	m.stage(job, "cleaning")
	m.recordBackup(ctx, job, configuration, fingerprint)
	return nil
}
