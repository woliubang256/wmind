package postgres

import (
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/contracttest"
)

func TestRepositoryContract(t *testing.T) {
	url := os.Getenv("WMIND_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("WMIND_TEST_DATABASE_URL is not set; PostgreSQL contract suite runs in CI")
	}

	db, err := Connect(t.Context(), url, 4)
	if err != nil {
		t.Fatalf("connect PostgreSQL: %v", err)
	}
	defer db.Close()

	migrationDB, err := OpenForMigration(url)
	if err != nil {
		t.Fatalf("open PostgreSQL migration connection: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := migrate.Up("postgres", migrationDB, logger); err != nil {
		_ = migrationDB.Close()
		t.Fatalf("apply PostgreSQL migrations: %v", err)
	}
	if err := migrationDB.Close(); err != nil {
		t.Fatalf("close PostgreSQL migration connection: %v", err)
	}

	contracttest.Run(t, contracttest.Repos{
		Users: NewUserRepository(db), Maps: NewMapRepository(db), Tx: NewTxManager(db),
		Tokens: NewRefreshTokenRepository(db), Settings: NewSettingsRepository(db), Audit: NewAuditRepository(db),
		Shares:    NewShareRepository(db),
		Templates: NewTemplateRepository(db),
		Themes:    NewThemeRepository(db),
		TwoFactor: NewTwoFactorRepository(db),
	})
}
