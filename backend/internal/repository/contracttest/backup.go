package contracttest

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/backupformat"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

// RunBackup exercises real dialect transactions against a disposable database.
func RunBackup(t *testing.T, repo domain.BackupRepository, exec func(string) error, scalar func(string) string) {
	t.Helper()
	ctx := t.Context()
	must := func(q string) {
		t.Helper()
		if err := exec(q); err != nil {
			t.Fatal(err)
		}
	}
	must(`INSERT INTO users(id,uid,username,email,password_hash,role) VALUES(9007199254740993,'backup-admin','backup-admin','backup@example.com','hash','admin')`)
	must(`INSERT INTO maps(id,uid,owner_id,title,document) VALUES(42,'backup-map',9007199254740993,'原始导图','{"hello":"世界"}')`)
	must(`INSERT INTO user_two_factor(user_id,state) VALUES(9007199254740993,'{"Enabled":true,"Secret":"encrypted-secret","SessionVersion":"old","PendingSecret":"pending","Challenges":[{"Hash":"old-challenge"}]}')`)
	must(`INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES(9007199254740993,'old-token','2099-01-01T00:00:00Z')`)
	must(`INSERT INTO login_challenges(hash,identifier_hash,sealed_key,expires_at) VALUES('transport-challenge','account-hash','sealed-key',9999999999999)`)
	id, err := repo.Identity(ctx)
	if err != nil || id.Schema < 3 {
		t.Fatalf("identity: %+v %v", id, err)
	}
	dir := t.TempDir()
	if err = repo.Export(ctx, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(backupformat.File(dir, "login_challenges")); !os.IsNotExist(err) {
		t.Fatal("short-lived login private keys must not enter backup archives")
	}
	if err = repo.Validate(ctx, dir); err != nil {
		t.Fatal(err)
	}
	must(`UPDATE maps SET title='更新后的导图'`)
	if err = repo.Restore(ctx, dir, func() (func() error, error) { return nil, errors.New("file install failed") }); err == nil {
		t.Fatal("accepted failed file installation")
	}
	if got := scalar(`SELECT title FROM maps WHERE id=42`); got != "更新后的导图" {
		t.Fatal("DB did not roll back", got)
	}
	if scalar(`SELECT count(*) FROM login_challenges`) != "1" {
		t.Fatal("failed restore changed login challenges")
	}
	installed := false
	if err = repo.Restore(ctx, dir, func() (func() error, error) {
		installed = true
		return func() error { installed = false; return nil }, nil
	}); err != nil {
		t.Fatal(err)
	}
	if !installed || scalar(`SELECT title FROM maps WHERE id=42`) != "原始导图" {
		t.Fatal("round trip failed")
	}
	if got := scalar(`SELECT count(*) FROM refresh_tokens`); got != "0" {
		t.Fatal("refresh sessions survived", got)
	}
	if scalar(`SELECT count(*) FROM login_challenges`) != "0" {
		t.Fatal("login encryption challenges survived restore")
	}
	state := scalar(`SELECT state FROM user_two_factor WHERE user_id=9007199254740993`)
	if !strings.Contains(state, "encrypted-secret") || strings.Contains(state, `"SessionVersion":"old"`) || strings.Contains(state, "old-challenge") || strings.Contains(state, `"PendingSecret":"pending"`) {
		t.Fatal("incorrect session invalidation", state)
	}
	if scalar(`SELECT owner_id FROM maps WHERE id=42`) != "9007199254740993" {
		t.Fatal("integer precision lost")
	}
	// Truncated and foreign-key-invalid rows must not replace current data.
	mapFile := backupformat.File(dir, "maps")
	raw, err := os.ReadFile(mapFile)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(mapFile, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = repo.Validate(ctx, dir); err == nil {
		t.Fatal("accepted incompatible columns")
	}
	bad := strings.Replace(string(raw), "9007199254740993", "999999999", 1)
	os.WriteFile(mapFile, []byte(bad), 0600)
	installed = false
	if err = repo.Restore(ctx, dir, func() (func() error, error) { installed = true; return nil, nil }); err == nil {
		t.Fatal("accepted broken foreign key")
	}
	if installed || scalar(`SELECT title FROM maps WHERE id=42`) != "原始导图" {
		t.Fatal("failed restore changed state")
	}
	// Restore remains usable after a cancelled attempt.
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err = repo.Export(cancelled, t.TempDir()); err == nil {
		t.Fatal("ignored cancellation")
	}
}
