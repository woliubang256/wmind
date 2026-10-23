package contracttest

import (
	"fmt"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

func TrashRetention(t *testing.T, trash domain.TrashRepo, users domain.UserRepo, maps domain.MapRepo) {
	t.Helper()
	ctx := t.Context()
	cutoff := time.Date(2024, 1, 1, 12, 0, 0, 0, time.UTC)
	prefix := ulid.Make().String()
	var all []*domain.Map
	for i := 0; i < 2; i++ {
		name := fmt.Sprintf("trash%s%d", prefix, i)
		owner, err := users.Create(ctx, domain.CreateUserInput{UID: name, Username: name, Email: name + "@example.test", PasswordHash: "hash", Role: domain.RoleUser, Status: domain.UserStatusActive, Now: cutoff})
		if err != nil {
			t.Fatal(err)
		}
		for j, deletedAt := range []time.Time{cutoff.Add(-time.Millisecond), cutoff, cutoff.Add(time.Millisecond), {}} {
			m, err := maps.Create(ctx, domain.CreateMapInput{UID: fmt.Sprintf("%s%d", name, j), OwnerID: owner.ID, Title: "retention", Document: []byte(`{}`), Now: cutoff.Add(-time.Hour)})
			if err != nil {
				t.Fatal(err)
			}
			if !deletedAt.IsZero() {
				if err := maps.SoftDelete(ctx, m.UID, owner.ID, deletedAt); err != nil {
					t.Fatal(err)
				}
			}
			all = append(all, m)
		}
	}
	// A restored topic must survive even though its old deletion time is expired.
	restored := all[0]
	if _, err := maps.Restore(ctx, restored.UID, restored.OwnerID, cutoff); err != nil {
		t.Fatal(err)
	}
	if n, err := trash.PurgeExpired(ctx, cutoff, 0); err != nil || n != 0 {
		t.Fatalf("zero batch: %d %v", n, err)
	}
	if n, err := trash.PurgeExpired(ctx, cutoff, 2); err != nil || n != 2 {
		t.Fatalf("first bounded batch: %d %v", n, err)
	}
	if n, err := trash.PurgeExpired(ctx, cutoff, 2); err != nil || n != 1 {
		t.Fatalf("second bounded batch: %d %v", n, err)
	}
	if n, err := trash.PurgeExpired(ctx, cutoff, 2); err != nil || n != 0 {
		t.Fatalf("finished: %d %v", n, err)
	}
	for _, m := range []*domain.Map{all[2], all[6]} {
		rows, err := maps.ListTrashed(ctx, m.OwnerID, domain.NewPage(1, 100))
		if err != nil || len(rows) != 1 || rows[0].UID != m.UID {
			t.Fatalf("one millisecond after cutoff must survive: %+v %v", rows, err)
		}
	}
	for _, m := range []*domain.Map{restored, all[3], all[7]} {
		if _, err := maps.GetByUID(ctx, m.UID, m.OwnerID); err != nil {
			t.Fatalf("active/restored map removed: %v", err)
		}
	}
	if err := maps.SoftDelete(ctx, restored.UID, restored.OwnerID, cutoff.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n, err := trash.PurgeExpired(ctx, cutoff.Add(time.Millisecond), 100); err != nil || n != 2 {
		t.Fatalf("next boundary: %d %v", n, err)
	}
	if _, err := maps.Restore(ctx, restored.UID, restored.OwnerID, cutoff.Add(time.Hour)); err != nil {
		t.Fatalf("re-delete should start a new retention interval: %v", err)
	}
}
