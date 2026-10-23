package contracttest

import (
	"fmt"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

func AdminStats(t *testing.T, stats domain.AdminStatsRepo, users domain.UserRepo, maps domain.MapRepo) {
	t.Helper()
	ctx := t.Context()
	from := time.Date(2042, 2, 1, 0, 0, 0, 0, time.UTC)
	until := from.AddDate(0, 0, 14)
	before, err := stats.Read(ctx, from, until)
	if err != nil {
		t.Fatal(err)
	}
	oldPoints := map[string]domain.AdminTrendPoint{}
	for _, p := range before.Trend {
		oldPoints[p.Date] = p
	}
	uid := ulid.Make().String()
	var owner *domain.User
	for i, status := range []domain.UserStatus{domain.UserStatusActive, domain.UserStatusDisabled, domain.UserStatusActive} {
		name := fmt.Sprintf("stats%s%d", uid, i)
		u, err := users.Create(ctx, domain.CreateUserInput{UID: name, Username: name, Email: name + "@example.test", PasswordHash: "hash", Role: domain.RoleUser, Status: status, Now: from})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			owner = u
		}
		if i == 2 {
			if err := users.SoftDelete(ctx, u.UID, from); err != nil {
				t.Fatal(err)
			}
		}
	}
	// 边界之前、恰好起点、当天末尾、恰好终点；末尾那张移入回收站。
	times := []time.Time{from.Add(-time.Millisecond), from, until.Add(-time.Millisecond), until}
	for i, at := range times {
		m, err := maps.Create(ctx, domain.CreateMapInput{UID: fmt.Sprintf("stats%s%d", uid, i), OwnerID: owner.ID, Title: "stats", Document: []byte(`{}`), SizeBytes: int64(10 * (i + 1)), NodeCount: 1, Now: at})
		if err != nil {
			t.Fatal(err)
		}
		if i == 2 {
			if err := maps.SoftDelete(ctx, m.UID, owner.ID, at); err != nil {
				t.Fatal(err)
			}
		}
	}
	after, err := stats.Read(ctx, from, until)
	if err != nil {
		t.Fatal(err)
	}
	if after.UserCount-before.UserCount != 2 || after.ActiveUserCount-before.ActiveUserCount != 1 || after.MapCount-before.MapCount != 3 || after.StorageUsedBytes-before.StorageUsedBytes != 100 {
		t.Fatalf("totals: before=%+v after=%+v", before, after)
	}
	deltas := map[string]domain.AdminTrendPoint{}
	for _, p := range after.Trend {
		old := oldPoints[p.Date]
		deltas[p.Date] = domain.AdminTrendPoint{NewUsers: p.NewUsers - old.NewUsers, NewMaps: p.NewMaps - old.NewMaps}
	}
	if first, last := deltas["2042-02-01"], deltas["2042-02-14"]; first.NewUsers != 3 || first.NewMaps != 1 || last.NewUsers != 0 || last.NewMaps != 1 {
		t.Fatalf("half-open UTC dates and retained soft deletes: %+v", deltas)
	}
	if _, err := stats.Read(ctx, until, until.AddDate(0, 0, 1)); err != nil {
		t.Fatal(err)
	}
}
