package sqlite

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/contracttest"
)

func TestTrashRetention(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "trash.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := migrate.Up("sqlite", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	contracttest.TrashRetention(t, NewTrashRepository(db), NewUserRepository(db), NewMapRepository(db))
}
