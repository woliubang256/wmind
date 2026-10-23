package sqlite

import (
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/contracttest"
)

func TestBackupRoundTrip(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "snapshot.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = migrate.Up("sqlite", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	contracttest.RunBackup(t, NewBackupRepository(db), func(q string) error { _, err := db.ExecContext(t.Context(), q); return err }, func(q string) string {
		var value any
		if err := db.QueryRowContext(t.Context(), q).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprint(value)
	})
}
