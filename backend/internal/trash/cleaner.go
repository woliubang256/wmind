// Package trash runs bounded retention cleanup, sharing the backup maintenance gate.
package trash

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

const BatchSize = 100

type Policy interface{ TrashRetentionDays() int }
type Gate interface {
	Enter() (leave func(), ok bool)
}

type Config struct {
	Repository domain.TrashRepo
	Policy     Policy
	Gate       Gate
	Logger     *slog.Logger
	Now        func() time.Time
	Interval   time.Duration
}

type Cleaner struct{ cfg Config }

func New(cfg Config) (*Cleaner, error) {
	if cfg.Repository == nil || cfg.Policy == nil || cfg.Gate == nil {
		return nil, errors.New("trash cleaner requires repository, retention policy and maintenance gate")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Interval <= 0 {
		cfg.Interval = time.Hour
	}
	return &Cleaner{cfg: cfg}, nil
}

// Sweep releases the gate between batches so maintenance can drain background writes too.
func (c *Cleaner) Sweep(ctx context.Context) (int64, error) {
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		leave, ok := c.cfg.Gate.Enter()
		if !ok {
			return total, nil
		}
		days := c.cfg.Policy.TrashRetentionDays()
		if days <= 0 {
			days = domain.DefaultTrashRetentionDays
		}
		cutoff := c.cfg.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour)
		n, err := c.cfg.Repository.PurgeExpired(ctx, cutoff, BatchSize)
		leave()
		total += n
		if err != nil {
			return total, err
		}
		if n < BatchSize {
			return total, nil
		}
	}
}

// Run sweeps on startup and once per interval until the server shuts down.
func (c *Cleaner) Run(ctx context.Context) {
	tick := time.NewTicker(c.cfg.Interval)
	defer tick.Stop()
	for {
		n, err := c.Sweep(ctx)
		if err != nil && ctx.Err() == nil {
			c.cfg.Logger.Error("回收站自动清理失败", "err", err)
		}
		if n > 0 {
			c.cfg.Logger.Info("回收站自动清理完成", "deleted", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
