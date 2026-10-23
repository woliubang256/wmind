package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

type statsRepoFunc func(context.Context, time.Time, time.Time) (*domain.AdminStats, error)

func (f statsRepoFunc) Read(ctx context.Context, a, b time.Time) (*domain.AdminStats, error) {
	return f(ctx, a, b)
}

type usageFunc func(context.Context) (int64, error)

func (f usageFunc) Usage(ctx context.Context) (int64, error) { return f(ctx) }

func TestAdminStatsContinuousUTCWindow(t *testing.T) {
	// 上海 1 月 1 日 07:30 仍是 UTC 的上一年，不能取服务器本地日界线。
	now := time.Date(2043, 1, 1, 7, 30, 0, 0, time.FixedZone("Shanghai", 8*3600))
	s := &AdminService{now: func() time.Time { return now }, uploads: usageFunc(func(context.Context) (int64, error) { return 9, nil }), stats: statsRepoFunc(func(_ context.Context, from, until time.Time) (*domain.AdminStats, error) {
		if from.Format(time.RFC3339) != "2042-12-18T00:00:00Z" || until.Format(time.RFC3339) != "2043-01-01T00:00:00Z" {
			t.Fatalf("bounds = %v %v", from, until)
		}
		return &domain.AdminStats{MapCount: 3, StorageUsedBytes: 100, Trend: []domain.AdminTrendPoint{{Date: "2042-12-31", NewMaps: 2, NewUsers: 1}}}, nil
	})}
	v, err := s.Stats(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Trend) != 14 || v.Trend[0].Date != "2042-12-18" || v.Trend[0].NewMaps != 0 || v.Trend[13].NewUsers != 1 || v.MapCountToday != 2 || v.StorageUsedBytes != 109 {
		t.Fatalf("stats = %+v", v)
	}
}

func TestAdminStatsErrorsAreNotZeros(t *testing.T) {
	failure := errors.New("unavailable")
	s := &AdminService{now: SystemClock, stats: statsRepoFunc(func(context.Context, time.Time, time.Time) (*domain.AdminStats, error) { return nil, failure })}
	if _, err := s.Stats(t.Context()); !errors.Is(err, failure) {
		t.Fatalf("repository error = %v", err)
	}
	s.stats = statsRepoFunc(func(context.Context, time.Time, time.Time) (*domain.AdminStats, error) {
		return &domain.AdminStats{}, nil
	})
	s.uploads = usageFunc(func(context.Context) (int64, error) { return 0, failure })
	if _, err := s.Stats(t.Context()); !errors.Is(err, failure) {
		t.Fatalf("storage error = %v", err)
	}
}
