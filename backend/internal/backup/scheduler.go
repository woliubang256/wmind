package backup

import (
	"context"
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
	m.mu.RLock()
	c := m.configuration
	m.mu.RUnlock()
	if !c.Enabled {
		return
	}
	next, err := Schedule(c.Cron, c.Timezone, minute.Add(-time.Minute))
	if err != nil || !next[0].Equal(minute) {
		return
	}
	_, _ = m.StartBackup("schedule") // A busy instance skips instead of queuing.
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
