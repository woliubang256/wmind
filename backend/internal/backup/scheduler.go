package backup

import (
	"context"
	"errors"
	"time"
)

// Tick evaluates just the current minute; missed executions are never replayed.
func (m *Manager) Tick(now time.Time) {
	minute := now.Truncate(time.Minute)
	m.tickMu.Lock()
	if !m.lastTick.Before(minute) {
		m.tickMu.Unlock()
		return
	}
	m.lastTick = minute
	m.tickMu.Unlock()
	if err := m.reserveLatest(m.ctx); err != nil {
		if !errors.Is(err, ErrBusy) {
			m.cfg.Logger.Warn("backup schedule skipped; current settings unavailable")
		}
		return
	}
	m.reclaimStaging(now)
	m.mu.RLock()
	c := m.configuration
	m.mu.RUnlock()
	if !c.Enabled {
		m.release()
		return
	}
	next, err := Schedule(c.Cron, c.Timezone, minute.Add(-time.Minute))
	if err != nil || !next[0].Equal(minute) {
		m.release()
		return
	}
	_, _ = m.startBackupReserved("schedule")
}
func (m *Manager) Run(ctx context.Context) {
	for {
		timer := time.NewTimer(time.Until(time.Now().Truncate(time.Minute).Add(time.Minute)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case now := <-timer.C:
			m.Tick(now)
		}
	}
}
