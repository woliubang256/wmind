package service

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"math/big"
	"path/filepath"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

func TestSharedLoginEncryption(t *testing.T) {
	db, err := sqlite.Open(filepath.Join(t.TempDir(), "login.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := migrate.Up("sqlite", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	const secret = "shared-login-encryption-test-secret-123456"
	a, err := NewLoginEncryption(sqlite.NewLoginChallengeRepository(db), secret)
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewLoginEncryption(sqlite.NewLoginChallengeRepository(db), secret)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	a.now = func() time.Time { return now }
	b.now = func() time.Time { return now }
	encrypt := func(c *EncryptedLoginChallenge) string {
		t.Helper()
		n, _ := base64.RawURLEncoding.DecodeString(c.PublicKey.N)
		e, _ := base64.RawURLEncoding.DecodeString(c.PublicKey.E)
		pub := rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
		data, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &pub, []byte("original-password"), []byte("wmind/login/v1:"+c.ChallengeID))
		if err != nil {
			t.Fatal(err)
		}
		return base64.StdEncoding.EncodeToString(data)
	}
	c, err := a.Issue(t.Context(), " Alice@Example.com ")
	if err != nil {
		t.Fatal(err)
	}
	if c.ExpiresIn != 120 {
		t.Fatal("unexpected expiry")
	}
	ciphertext := encrypt(c)
	var hash, identifier, key string
	if err := db.QueryRow("SELECT hash, identifier_hash, sealed_key FROM login_challenges").Scan(&hash, &identifier, &key); err != nil {
		t.Fatal(err)
	}
	if len(hash) != 64 || len(identifier) != 64 || key == "" || hash == c.ChallengeID {
		t.Fatal("challenge storage must contain only hashes and sealed keys")
	}
	plain, err := b.Decrypt(t.Context(), "alice@example.COM", c.ChallengeID, ciphertext)
	if err != nil || plain != "original-password" {
		t.Fatalf("independent instances: %v", err)
	}
	if _, err := a.Decrypt(t.Context(), "alice@example.com", c.ChallengeID, ciphertext); err == nil {
		t.Fatal("replay accepted by issuing instance")
	}
	c, err = a.Issue(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	b.now = func() time.Time { return now.Add(loginChallengeTTL) }
	if _, err := b.Decrypt(t.Context(), "alice", c.ChallengeID, encrypt(c)); err == nil {
		t.Fatal("expiry boundary accepted")
	}
	if _, err := a.Issue(t.Context(), " "); err == nil {
		t.Fatal("empty identifier accepted")
	}
}
