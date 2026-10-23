package postgres

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/contracttest"
)

func TestBackupRoundTrip(t *testing.T) {
	url := os.Getenv("WMIND_TEST_BACKUP_DATABASE_URL")
	if url == "" {
		t.Skip("set WMIND_TEST_BACKUP_DATABASE_URL to an isolated disposable database")
	}
	db, err := Connect(t.Context(), url, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	migrations, err := OpenForMigration(url)
	if err != nil {
		t.Fatal(err)
	}
	defer migrations.Close()
	if err = migrate.Up("postgres", migrations, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	// This environment variable is deliberately separate from contract databases.
	contracttest.RunBackup(t, NewBackupRepository(db), func(q string) error { _, err := db.Exec(t.Context(), q); return err }, func(q string) string {
		var value any
		if err := db.QueryRow(t.Context(), q).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprint(value)
	})
}
