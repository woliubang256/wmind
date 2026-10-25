package sqlite

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/woliubang256/wmind/backend/db/migrations"
	"github.com/woliubang256/wmind/backend/internal/migrate"
)

func TestSharePasswordMigrationPreservesLegacyLinks(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := migrate.Up("sqlite", db, log); err != nil {
		t.Fatal(err)
	}
	down, err := migrations.SQLiteFS.ReadFile("sqlite/0006_share_password_ciphertext.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		string(down), `UPDATE schema_migrations SET version=5`,
		`INSERT INTO users(id,uid,username,email,password_hash) VALUES(1,'owner','owner','owner@example.com','hash')`,
		`INSERT INTO maps(id,uid,owner_id,document) VALUES(1,'map',1,'{}')`,
		`INSERT INTO share_links(uid,token,map_id,owner_id,password_hash) VALUES('legacy','token',1,1,'old-bcrypt')`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate.Up("sqlite", db, log); err != nil {
		t.Fatal(err)
	}
	link, err := NewShareRepository(db).GetByUID(context.Background(), "legacy", 1)
	if err != nil || link.PasswordHash != "old-bcrypt" || link.PasswordCiphertext != "" {
		t.Fatalf("legacy migration: %v %#v", err, link)
	}
}
