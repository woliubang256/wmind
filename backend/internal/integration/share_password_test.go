package integration_test

import (
	"database/sql"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
)

func TestSharePasswordPersistsAcrossDatabaseReopens(t *testing.T) {
	ctx := t.Context()
	dbPath := filepath.Join(t.TempDir(), "shares.db")
	open := func() *sql.DB {
		t.Helper()
		db, err := sqlite.Open(dbPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := migrate.Up("sqlite", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
			db.Close()
			t.Fatal(err)
		}
		return db
	}
	db := open()
	t.Cleanup(func() { db.Close() })
	for _, query := range []string{
		`INSERT INTO users(id,uid,username,email,password_hash) VALUES(1,'owner','owner','owner@example.test','unchanged-login-hash')`,
		`INSERT INTO maps(id,uid,owner_id,title,document) VALUES(1,'map',1,'持久分享','{"title":"持久分享"}')`,
	} {
		if _, err := db.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	start := func(key string) *service.ShareService {
		t.Helper()
		tokens, err := auth.NewShareTokenIssuer("share-integration-signing-key-32-bytes", auth.DefaultShareAccessTTL)
		if err != nil {
			t.Fatal(err)
		}
		var legacy *auth.SharePasswordCipher
		if key != "" {
			legacy, err = auth.NewSharePasswordCipher(key)
			if err != nil {
				t.Fatal(err)
			}
		}
		svc, err := service.NewShareService(service.ShareServiceConfig{
			Shares: sqlite.NewShareRepository(db), Maps: sqlite.NewMapRepository(db),
			Tokens: tokens, Passwords: legacy,
		})
		if err != nil {
			t.Fatal(err)
		}
		return svc
	}
	svc := start(strings.Repeat("a", 32))
	created, err := svc.Create(ctx, "map", 1, service.CreateShareInput{Password: "Ab9x"})
	if err != nil {
		t.Fatal(err)
	}
	assertReadable := func(svc *service.ShareService) {
		t.Helper()
		for read := 0; read < 2; read++ {
			byMap, err := svc.ListByMap(ctx, "map", 1)
			if err != nil || len(byMap) != 1 || byMap[0].Password == nil || *byMap[0].Password != "Ab9x" {
				t.Fatal("repeated map-owner reads must retain the saved password", err)
			}
			mine, total, err := svc.ListMine(ctx, 1, "", 1, 20)
			if err != nil || total != 1 || len(mine) != 1 || mine[0].Password == nil || *mine[0].Password != "Ab9x" {
				t.Fatal("repeated My shares reads must retain the saved password", err)
			}
			access, _, err := svc.VerifyPassword(ctx, created.Token, "Ab9x")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.ReadPublic(ctx, created.Token, access, "127.0.0.1"); err != nil {
				t.Fatal(err)
			}
			row, err := sqlite.NewShareRepository(db).GetByUID(ctx, created.UID, 1)
			if err != nil || row.PasswordCiphertext != "plain:Ab9x" {
				t.Fatal("viewing and verifying must not consume the stored plaintext", err)
			}
			public, err := sqlite.NewShareRepository(db).GetByToken(ctx, created.Token)
			if err != nil || public.Share.PasswordCiphertext != "" || public.Share.Password != nil {
				t.Fatal("the public query must not read the owner-only password value", err)
			}
		}
	}
	assertReadable(svc)
	for _, key := range []string{strings.Repeat("a", 32), strings.Repeat("b", 32), ""} {
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		db = open()
		svc = start(key)
		assertReadable(svc)
	}
	notes := true
	updated, err := svc.Update(ctx, created.UID, 1, service.UpdateShareInput{ShowNotes: &notes})
	if err != nil || updated.Password == nil || *updated.Password != "Ab9x" {
		t.Fatal("unrelated settings must preserve the saved password", err)
	}
	next := "Cd8y"
	updated, err = svc.Update(ctx, created.UID, 1, service.UpdateShareInput{Password: &next})
	if err != nil || updated.Password == nil || *updated.Password != next {
		t.Fatal("reset must work without a legacy key", err)
	}
	empty := ""
	updated, err = svc.Update(ctx, created.UID, 1, service.UpdateShareInput{Password: &empty})
	if err != nil || updated.HasPassword() || updated.Password != nil || updated.PasswordCiphertext != "" {
		t.Fatal("clearing must erase both password representations", err)
	}
	var loginHash string
	if err := db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id=1`).Scan(&loginHash); err != nil || loginHash != "unchanged-login-hash" {
		t.Fatal("share password changes must not touch account passwords", err)
	}
}
