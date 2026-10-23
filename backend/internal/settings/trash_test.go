package settings_test

import (
	"testing"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

func TestTrashRetentionSettings(t *testing.T) {
	svc := newService(t, newFakeRepo())
	if got := svc.TrashRetentionDays(); got != domain.DefaultTrashRetentionDays {
		t.Fatalf("default retention = %d", got)
	}
	for _, invalid := range []any{0, -1, 3651, 1.5, "30"} {
		if _, err := svc.Update(t.Context(), map[string]any{"trash.retention_days": invalid}, nil); err == nil {
			t.Fatalf("accepted invalid retention: %v", invalid)
		}
	}
	if _, err := svc.Update(t.Context(), map[string]any{"trash.retention_days": 7}, nil); err != nil {
		t.Fatal(err)
	}
	if got := svc.TrashRetentionDays(); got != 7 {
		t.Fatalf("updated retention = %d", got)
	}
	if _, public := svc.Snapshot().Public()["trash.retention_days"]; public {
		t.Fatal("retention should remain admin-only")
	}
	if err := svc.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := svc.TrashRetentionDays(); got != 7 {
		t.Fatalf("persisted retention = %d", got)
	}
}
