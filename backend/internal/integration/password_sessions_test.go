package integration_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
)

func TestPasswordSessionsRevokedAcrossInstances(t *testing.T) {
	f := adminSessions(t)
	second, err := f.auth[1].Login(t.Context(), service.LoginInput{Identifier: "sessionuser", Password: "session-test-password"})
	if err != nil {
		t.Fatal(err)
	}
	// Keep a normally rotated historical token too: global revocation must retire
	// its replay marker, not only tokens which happened to be active at the change.
	rotated, err := f.auth[1].Refresh(t.Context(), second.RefreshToken, service.SessionMeta{})
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := f.auth[0].ChangePassword(t.Context(), f.initial.User.UID, "session-test-password", "new-session-password", service.SessionMeta{Device: "current-browser"})
	if err != nil {
		t.Fatal(err)
	}
	oldMedia, err := f.auth[0].MediaToken(f.initial)
	if err != nil {
		t.Fatal(err)
	}
	newMedia, err := f.auth[0].MediaToken(replaced)
	if err != nil {
		t.Fatal(err)
	}
	for _, svc := range f.auth {
		if _, err := svc.AuthenticateMedia(t.Context(), oldMedia); err == nil {
			t.Error("prior media credential still valid")
		}
		if _, err := svc.AuthenticateMedia(t.Context(), newMedia); err != nil {
			t.Fatalf("replacement media: %v", err)
		}
		for _, prior := range []*service.AuthResult{f.initial, second, rotated} {
			if _, err := svc.Authenticate(t.Context(), prior.AccessToken); err == nil {
				t.Error("prior access token still valid")
			}
			stored, err := f.tokens.GetByHash(t.Context(), auth.HashRefreshToken(prior.RefreshToken))
			if err != nil || !stored.Revoked() {
				t.Fatalf("prior refresh token not revoked: %v", err)
			}
		}
		if _, err := svc.Authenticate(t.Context(), replaced.AccessToken); err != nil {
			t.Fatalf("replacement access: %v", err)
		}
	}
	for _, prior := range []*service.AuthResult{f.initial, second, rotated} {
		if _, err := f.auth[1].Refresh(t.Context(), prior.RefreshToken, service.SessionMeta{}); err == nil {
			t.Error("prior refresh token accepted")
		}
	}
	if _, err := f.auth[1].Refresh(t.Context(), replaced.RefreshToken, service.SessionMeta{}); err != nil {
		t.Fatalf("old-device refresh revoked current replacement session: %v", err)
	}
}

type failPasswordSessionCreate struct{ domain.RefreshTokenRepo }

func (failPasswordSessionCreate) Create(context.Context, domain.CreateRefreshTokenInput) (*domain.RefreshToken, error) {
	return nil, errors.New("injected replacement-session failure")
}

func TestPasswordSessionsFailureRollsBack(t *testing.T) {
	for _, failure := range []string{"revoke", "version", "issue"} {
		t.Run(failure, func(t *testing.T) {
			f := adminSessions(t)
			tokens, factors := f.tokens, f.factor
			switch failure {
			case "revoke":
				tokens = failSessionRevoke{tokens}
			case "version":
				factors = failSessionVersion{factors}
			case "issue":
				tokens = failPasswordSessionCreate{tokens}
			}
			svc, err := service.NewAuthService(f.users, tokens, sqlite.NewTxManager(f.db), service.AuthServiceConfig{
				Issuer: f.issuer, TwoFactor: factors, TwoFactorKey: "admin-session-test-encryption-secret",
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.ChangePassword(t.Context(), f.initial.User.UID, "session-test-password", "new-session-password", service.SessionMeta{}); err == nil {
				t.Fatal("reported success on failure")
			}
			user, err := f.users.GetByUID(t.Context(), f.initial.User.UID)
			if err != nil || !auth.VerifyPassword(user.PasswordHash, "session-test-password") {
				t.Fatalf("password not rolled back: %v", err)
			}
			if _, err := f.auth[1].Authenticate(t.Context(), f.initial.AccessToken); err != nil {
				t.Fatalf("access not rolled back: %v", err)
			}
			if _, err := f.auth[1].Refresh(t.Context(), f.initial.RefreshToken, service.SessionMeta{}); err != nil {
				t.Fatalf("refresh not rolled back: %v", err)
			}
		})
	}
}

func TestPasswordSessionsConcurrentChange(t *testing.T) {
	f := adminSessions(t)
	var group sync.WaitGroup
	results := make(chan *service.AuthResult, 2)
	for _, svc := range f.auth {
		group.Add(1)
		go func(svc *service.AuthService) {
			defer group.Done()
			result, err := svc.ChangePassword(t.Context(), f.initial.User.UID, "session-test-password", "new-session-password", service.SessionMeta{})
			if err == nil {
				results <- result
			}
		}(svc)
	}
	group.Wait()
	close(results)
	count := 0
	for result := range results {
		count++
		if _, err := f.auth[1].Authenticate(t.Context(), result.AccessToken); err != nil {
			t.Fatalf("winning session invalid: %v", err)
		}
	}
	if count != 1 {
		t.Fatalf("successful concurrent changes = %d, want 1", count)
	}
}

func TestPasswordSessionsWaitingReplayDoesNotCrossSecurityBoundary(t *testing.T) {
	f := adminSessions(t)
	if _, err := f.auth[0].Refresh(t.Context(), f.initial.RefreshToken, service.SessionMeta{}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	pause := pausedSessionTx{sqlite.NewTxManager(f.db), make(chan struct{}), make(chan struct{})}
	svc, err := service.NewAuthService(f.users, f.tokens, pause, service.AuthServiceConfig{Issuer: f.issuer, TwoFactor: f.factor, TwoFactorKey: "admin-session-test-encryption-secret"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := svc.Refresh(ctx, f.initial.RefreshToken, service.SessionMeta{}); done <- err }()
	select {
	case <-pause.entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	replaced, changeErr := f.auth[1].ChangePassword(ctx, f.initial.User.UID, "session-test-password", "new-session-password", service.SessionMeta{})
	close(pause.release)
	if changeErr != nil {
		t.Fatal(changeErr)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("waiting replay unexpectedly succeeded")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := f.auth[1].Refresh(ctx, replaced.RefreshToken, service.SessionMeta{}); err != nil {
		t.Fatalf("waiting replay revoked replacement: %v", err)
	}
}
