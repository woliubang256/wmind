package trash

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/backup"
)

type retention int

func (p *retention) TrashRetentionDays() int { return int(*p) }

type purgeFunc func(context.Context, time.Time, int) (int64, error)

func (fn purgeFunc) PurgeExpired(ctx context.Context, cutoff time.Time, batch int) (int64, error) {
	return fn(ctx, cutoff, batch)
}

type testGate struct {
	enters, leaves int
	stopAfter      int
}

func (g *testGate) Enter() (func(), bool) {
	if g.stopAfter > 0 && g.enters >= g.stopAfter {
		return nil, false
	}
	g.enters++
	return func() { g.leaves++ }, true
}

func TestSweepBatchesAndPolicyChange(t *testing.T) {
	now := time.Date(2026, 10, 24, 10, 0, 0, 0, time.UTC)
	policy := retention(30)
	gate := &testGate{}
	calls := 0
	cleaner, err := New(Config{Policy: &policy, Gate: gate, Now: func() time.Time { return now }, Repository: purgeFunc(func(_ context.Context, cutoff time.Time, batch int) (int64, error) {
		calls++
		days := 30
		if calls > 1 {
			days = 7
		}
		if want := now.Add(-time.Duration(days) * 24 * time.Hour); !cutoff.Equal(want) || batch != BatchSize {
			t.Fatalf("cutoff=%v batch=%d", cutoff, batch)
		}
		policy = 7
		if calls < 3 {
			return BatchSize, nil
		}
		return 3, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	n, err := cleaner.Sweep(t.Context())
	if err != nil || n != 203 || calls != 3 || gate.enters != 3 || gate.leaves != 3 {
		t.Fatalf("batches: %d %v calls=%d gate=%+v", n, err, calls, gate)
	}
}

func TestSweepMaintenanceCancellationAndFailure(t *testing.T) {
	policy := retention(30)
	gate := &backup.Gate{}
	calls := 0
	fail := errors.New("database unavailable")
	cleaner, err := New(Config{Policy: &policy, Gate: gate, Repository: purgeFunc(func(context.Context, time.Time, int) (int64, error) { calls++; return 0, fail })})
	if err != nil {
		t.Fatal(err)
	}
	resume := gate.Pause()
	if n, err := cleaner.Sweep(t.Context()); n != 0 || err != nil || calls != 0 {
		t.Fatalf("paused cleanup ran: %d %v", n, err)
	}
	resume()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := cleaner.Sweep(ctx); !errors.Is(err, context.Canceled) || calls != 0 {
		t.Fatalf("canceled cleanup ran: %v", err)
	}
	if _, err := cleaner.Sweep(t.Context()); !errors.Is(err, fail) || calls != 1 {
		t.Fatalf("failure hidden: %v", err)
	}
	// Errors must release the read lease or the next restore would deadlock.
	resume = gate.Pause()
	resume()
}

func TestSweepYieldsBetweenBatches(t *testing.T) {
	policy := retention(30)
	gate := &testGate{stopAfter: 1}
	cleaner, err := New(Config{Policy: &policy, Gate: gate, Repository: purgeFunc(func(context.Context, time.Time, int) (int64, error) { return BatchSize, nil })})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := cleaner.Sweep(t.Context()); err != nil || n != BatchSize || gate.leaves != 1 {
		t.Fatalf("did not yield to maintenance: %d %v %+v", n, err, gate)
	}
}

func TestRunStartsImmediatelyRepeatsAndStops(t *testing.T) {
	policy := retention(30)
	calls := make(chan struct{}, 100)
	cleaner, err := New(Config{Policy: &policy, Gate: &backup.Gate{}, Interval: 5 * time.Millisecond, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Repository: purgeFunc(func(context.Context, time.Time, int) (int64, error) { calls <- struct{}{}; return 0, nil })})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); cleaner.Run(ctx) }()
	for i := 0; i < 2; i++ {
		select {
		case <-calls:
		case <-time.After(time.Second):
			t.Fatal("startup/periodic cleanup missing")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not stop")
	}
}
