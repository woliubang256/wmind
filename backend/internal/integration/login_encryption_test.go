package integration_test

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

	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
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
	a, err := service.NewLoginEncryption(sqlite.NewLoginChallengeRepository(db), secret)
	if err != nil {
		t.Fatal(err)
	}
	b, err := service.NewLoginEncryption(sqlite.NewLoginChallengeRepository(db), secret)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := a.Issue(t.Context(), " Alice@Example.com ")
	if err != nil {
		t.Fatal(err)
	}
	n, err := base64.RawURLEncoding.DecodeString(challenge.PublicKey.N)
	if err != nil {
		t.Fatal(err)
	}
	e, err := base64.RawURLEncoding.DecodeString(challenge.PublicKey.E)
	if err != nil {
		t.Fatal(err)
	}
	pub := rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	data, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &pub, []byte("original-password"), []byte("wmind/login/v1:"+challenge.ChallengeID))
	if err != nil {
		t.Fatal(err)
	}
	ciphertext := base64.StdEncoding.EncodeToString(data)
	plain, err := b.Decrypt(t.Context(), "alice@example.COM", challenge.ChallengeID, ciphertext)
	if err != nil || plain != "original-password" {
		t.Fatalf("independent instances: %v", err)
	}
	if _, err := a.Decrypt(t.Context(), "alice@example.com", challenge.ChallengeID, ciphertext); err == nil {
		t.Fatal("replay accepted by issuing instance")
	}
}
