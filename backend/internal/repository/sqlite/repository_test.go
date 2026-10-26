package sqlite

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/contracttest"
)

func TestRepositoryContract(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "contract.db"))
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	defer db.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := migrate.Up("sqlite", db, logger); err != nil {
		t.Fatalf("apply SQLite migrations: %v", err)
	}
	contracttest.Run(t, contracttest.Repos{
		Users: NewUserRepository(db), Maps: NewMapRepository(db), Tx: NewTxManager(db),
		Tokens: NewRefreshTokenRepository(db), Settings: NewSettingsRepository(db), Audit: NewAuditRepository(db),
		Shares:    NewShareRepository(db),
		Templates: NewTemplateRepository(db),
		Themes:    NewThemeRepository(db),
		TwoFactor: NewTwoFactorRepository(db),
	})
	contracttest.RunLoginChallenges(t, NewLoginChallengeRepository(db), NewTxManager(db))
	contracttest.RunUploadReferences(t, NewUploadReferencesRepository(db), NewUserRepository(db), NewMapRepository(db), NewTemplateRepository(db), NewSettingsRepository(db))
}
