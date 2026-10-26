package backup

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// Gate drains in-flight business requests before capturing/restoring DB+files.
// New requests fail promptly rather than queuing behind a maintenance window.
type Gate struct {
	mu       sync.RWMutex
	paused   atomic.Bool
	pauseMu  sync.Mutex
	lockPath string
}

// NewSharedGate coordinates every process using the same local upload volume.
// The lock lives outside UploadDir because restoration atomically replaces it.
func NewSharedGate(uploadDir string) (*Gate, error) {
	root, err := filepath.EvalSymlinks(uploadDir)
	if err != nil {
		return nil, fmt.Errorf("resolve maintenance root: %w", err)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	g := &Gate{lockPath: filepath.Join(filepath.Dir(root), "."+filepath.Base(root)+"-wmind-maintenance.lock")}
	leave, _, err := sharedFileLock(g.lockPath, false)
	if err != nil {
		return nil, fmt.Errorf("initialize shared maintenance lock: %w", err)
	}
	if leave != nil {
		leave()
	}
	return g, nil
}

func (g *Gate) Enter() (leave func(), ok bool) {
	if g.paused.Load() || !g.mu.TryRLock() {
		return nil, false
	}
	if g.paused.Load() {
		g.mu.RUnlock()
		return nil, false
	}
	releaseFile, ok, err := sharedFileLock(g.lockPath, false)
	if err != nil || !ok {
		g.mu.RUnlock()
		return nil, false
	}
	return func() { releaseFile(); g.mu.RUnlock() }, true
}

// Pause is retained for zero-value callers. Production jobs use PauseContext
// so a cancelled job or filesystem failure cannot silently run without a lock.
func (g *Gate) Pause() func() {
	resume, err := g.PauseContext(context.Background())
	if err != nil {
		panic(err)
	}
	return resume
}

func (g *Gate) PauseContext(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for !g.pauseMu.TryLock() {
		if err := gateWait(ctx); err != nil {
			return nil, err
		}
	}
	g.paused.Store(true)
	for !g.mu.TryLock() {
		if err := gateWait(ctx); err != nil {
			g.paused.Store(false)
			g.pauseMu.Unlock()
			return nil, err
		}
	}
	for {
		releaseFile, ok, err := sharedFileLock(g.lockPath, true)
		if err != nil {
			g.mu.Unlock()
			g.paused.Store(false)
			g.pauseMu.Unlock()
			return nil, err
		}
		if ok {
			return g.resume(releaseFile), nil
		}
		if err := gateWait(ctx); err != nil {
			g.mu.Unlock()
			g.paused.Store(false)
			g.pauseMu.Unlock()
			return nil, err
		}
	}
}

// TryPause lets background collection skip busy instances instead of holding up
// an editing/upload request. No lock is retained on any unsuccessful path.
func (g *Gate) TryPause() (func(), bool, error) {
	if !g.pauseMu.TryLock() {
		return nil, false, nil
	}
	g.paused.Store(true)
	if !g.mu.TryLock() {
		g.paused.Store(false)
		g.pauseMu.Unlock()
		return nil, false, nil
	}
	releaseFile, ok, err := sharedFileLock(g.lockPath, true)
	if err != nil || !ok {
		g.mu.Unlock()
		g.paused.Store(false)
		g.pauseMu.Unlock()
		return nil, false, err
	}
	return g.resume(releaseFile), true, nil
}

func (g *Gate) resume(releaseFile func()) func() {
	return func() { releaseFile(); g.mu.Unlock(); g.paused.Store(false); g.pauseMu.Unlock() }
}

func gateWait(ctx context.Context) error {
	timer := time.NewTimer(20 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
