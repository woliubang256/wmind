package sqlite

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/contracttest"
)

func TestAdminStats(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "stats.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := migrate.Up("sqlite", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	stats := NewAdminStatsRepository(db)
	empty, err := stats.Read(t.Context(), time.Now().AddDate(0, 0, -14), time.Now())
	if err != nil || empty.UserCount != 0 || empty.MapCount != 0 || empty.StorageUsedBytes != 0 || len(empty.Trend) != 0 {
		t.Fatalf("empty: %+v %v", empty, err)
	}
	contracttest.AdminStats(t, stats, NewUserRepository(db), NewMapRepository(db))
}
