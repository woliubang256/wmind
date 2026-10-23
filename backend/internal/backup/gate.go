package backup

import (
	"sync"
	"sync/atomic"
)

// Gate drains in-flight business requests before capturing/restoring DB+files.
// New requests fail promptly rather than queuing behind a maintenance window.
type Gate struct {
	mu     sync.RWMutex
	paused atomic.Bool
}

func (g *Gate) Enter() (leave func(), ok bool) {
	if g.paused.Load() || !g.mu.TryRLock() {
		return nil, false
	}
	if g.paused.Load() {
		g.mu.RUnlock()
		return nil, false
	}
	return g.mu.RUnlock, true
}
func (g *Gate) Pause() func() {
	g.paused.Store(true)
	g.mu.Lock()
	return func() { g.mu.Unlock(); g.paused.Store(false) }
}
