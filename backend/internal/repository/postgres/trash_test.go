package postgres

import (
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/contracttest"
)

func TestTrashRetention(t *testing.T) {
	url := os.Getenv("WMIND_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("WMIND_TEST_DATABASE_URL not set")
	}
	pool, err := Connect(t.Context(), url, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	db, err := OpenForMigration(url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := migrate.Up("postgres", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	contracttest.TrashRetention(t, NewTrashRepository(pool), NewUserRepository(pool), NewMapRepository(pool))
}
