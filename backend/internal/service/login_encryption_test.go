package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

type loginChallengeStub struct {
	state     domain.LoginChallenge
	createdAt int64
	consume   func(hash, identifier string, now int64) (*domain.LoginChallenge, error)
}

func (r *loginChallengeStub) Create(_ context.Context, state domain.LoginChallenge, now int64) error {
	r.state, r.createdAt = state, now
	return nil
}

func (r *loginChallengeStub) Consume(_ context.Context, hash, identifier string, now int64) (*domain.LoginChallenge, error) {
	return r.consume(hash, identifier, now)
}

func TestLoginEncryptionValidityWindow(t *testing.T) {
	repo := &loginChallengeStub{}
	svc, err := NewLoginEncryption(repo, "shared-login-encryption-test-secret-123456")
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1800000000123)
	svc.now = func() time.Time { return now }
	challenge, err := svc.Issue(t.Context(), " Alice@Example.com ")
	if err != nil {
		t.Fatal(err)
	}
	if challenge.ExpiresIn != 120 || repo.createdAt != now.UnixMilli() || repo.state.ExpiresAt != now.Add(2*time.Minute).UnixMilli() {
		t.Fatal("challenge must have a precise 120-second validity window")
	}
	if len(repo.state.Hash) != 64 || len(repo.state.IdentifierHash) != 64 || repo.state.SealedKey == "" || repo.state.Hash == challenge.ChallengeID {
		t.Fatal("challenge storage must contain only hashes and sealed keys")
	}
	called := false
	repo.consume = func(hash, identifier string, at int64) (*domain.LoginChallenge, error) {
		called = true
		if hash != repo.state.Hash || identifier != repo.state.IdentifierHash || at != repo.state.ExpiresAt {
			t.Fatal("consume must bind the normalized account and pass the current expiry boundary")
		}
		return nil, domain.ErrNotFound
	}
	now = now.Add(2 * time.Minute)
	if _, err := svc.Decrypt(t.Context(), "alice@example.COM", challenge.ChallengeID, "unused"); err == nil || !called {
		t.Fatal("expired challenge must be rejected")
	}
	repo.consume = func(string, string, int64) (*domain.LoginChallenge, error) {
		t.Fatal("invalid input must not reach the repository")
		return nil, domain.ErrNotFound
	}
	if _, err := svc.Decrypt(t.Context(), "alice", "invalid", "unused"); err == nil {
		t.Fatal("malformed challenge accepted")
	}
	for _, identifier := range []string{" ", strings.Repeat("a", 321)} {
		if _, err := svc.Issue(t.Context(), identifier); err == nil {
			t.Fatal("invalid identifier accepted")
		}
	}
}
