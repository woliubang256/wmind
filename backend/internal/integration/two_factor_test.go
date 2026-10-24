package integration_test

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
)

type factorFixture struct {
	svc     *service.AuthService
	now     *time.Time
	initial *service.AuthResult
	setup   *service.TwoFactorSetup
	repo    domain.TwoFactorRepo
}

func factorServer(t *testing.T) factorFixture {
	t.Helper()
	db, err := sqlite.Open(filepath.Join(t.TempDir(), "mfa.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = migrate.Up("sqlite", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1800000000, 0)
	issuer, _ := auth.NewTokenIssuer("service-test-key-32-bytes-at-least", 15*time.Minute)
	issuer.SetClock(func() time.Time { return now })
	repo := sqlite.NewTwoFactorRepository(db)
	svc, err := service.NewAuthService(sqlite.NewUserRepository(db), sqlite.NewRefreshTokenRepository(db), sqlite.NewTxManager(db), service.AuthServiceConfig{Issuer: issuer, Now: func() time.Time { return now }, TwoFactor: repo, TwoFactorKey: "test-mfa-encryption-key-at-least-32"})
	if err != nil {
		t.Fatal(err)
	}
	initial, err := svc.Register(t.Context(), service.RegisterInput{Username: "factoruser", Email: "factor@example.test", Password: "factor-test-password"})
	if err != nil {
		t.Fatal(err)
	}
	setup, err := svc.SetupTwoFactor(t.Context(), initial.User.UID, "factor-test-password")
	if err != nil {
		t.Fatal(err)
	}
	return factorFixture{svc, &now, initial, setup, repo}
}
func codeAt(t *testing.T, secret string, now time.Time) string {
	t.Helper()
	code, err := totp.GenerateCode(secret, now)
	if err != nil {
		t.Fatal(err)
	}
	return code
}
func (f factorFixture) enable(t *testing.T) *service.TwoFactorChange {
	t.Helper()
	r, err := f.svc.EnableTwoFactor(t.Context(), f.initial.User.UID, "factor-test-password", codeAt(t, f.setup.Secret, *f.now))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func (f factorFixture) challenge(t *testing.T) string {
	t.Helper()
	r, err := f.svc.Login(t.Context(), service.LoginInput{Identifier: "factoruser", Password: "factor-test-password"})
	if err != nil {
		t.Fatal(err)
	}
	if r.ChallengeToken == "" || r.AccessToken != "" || r.RefreshToken != "" || r.User != nil {
		t.Fatal("password step issued a session")
	}
	if _, err = f.svc.Authenticate(t.Context(), r.ChallengeToken); err == nil {
		t.Fatal("challenge accepted as access token")
	}
	return r.ChallengeToken
}
func expectCode(t *testing.T, err error, code apperr.Code) {
	t.Helper()
	if err == nil || apperr.From(err).Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func TestTwoFactorLifecycle(t *testing.T) {
	f := factorServer(t)
	ctx := t.Context()
	uid := f.initial.User.UID
	if !strings.HasPrefix(f.setup.QRCode, "data:image/png;base64,") || !strings.HasPrefix(f.setup.URI, "otpauth://totp/") {
		t.Fatal("invalid provisioning")
	}
	before, _ := f.svc.TwoFactorStatus(ctx, uid)
	if before.Enabled {
		t.Fatal("enabled before confirmation")
	}
	_, err := f.svc.EnableTwoFactor(ctx, uid, "wrong", "000000")
	expectCode(t, err, apperr.CodeAuthInvalidCredentials)
	if _, err = f.svc.Authenticate(ctx, f.initial.AccessToken); err != nil {
		t.Fatal(err)
	} // prime cache
	enabled := f.enable(t)
	if len(enabled.RecoveryCodes) != 10 {
		t.Fatal("missing recovery codes")
	}
	state, err := f.repo.Get(ctx, f.initial.User.ID, false)
	if err != nil || strings.Contains(state.Secret, f.setup.Secret) || state.PendingSecret != "" {
		t.Fatal("plaintext/pending secret persisted", err)
	}
	if _, err = f.svc.Authenticate(ctx, f.initial.AccessToken); err == nil {
		t.Fatal("cached old access token survived enable")
	}
	if _, err = f.svc.Refresh(ctx, f.initial.RefreshToken, service.SessionMeta{}); err == nil {
		t.Fatal("old refresh survived enable")
	}
	challenge := f.challenge(t)
	_, err = f.svc.VerifyTwoFactorLogin(ctx, challenge, codeAt(t, f.setup.Secret, *f.now), service.SessionMeta{})
	expectCode(t, err, apperr.CodeAuthTwoFactorInvalid)
	*f.now = f.now.Add(30 * time.Second)
	logged, err := f.svc.VerifyTwoFactorLogin(ctx, challenge, codeAt(t, f.setup.Secret, *f.now), service.SessionMeta{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Authenticate(ctx, logged.AccessToken); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.VerifyTwoFactorLogin(ctx, challenge, enabled.RecoveryCodes[0], service.SessionMeta{})
	expectCode(t, err, apperr.CodeAuthTwoFactorExpired)
	second := f.challenge(t)
	if _, err = f.svc.VerifyTwoFactorLogin(ctx, second, enabled.RecoveryCodes[0], service.SessionMeta{}); err != nil {
		t.Fatal(err)
	}
	status, _ := f.svc.TwoFactorStatus(ctx, uid)
	if status.RecoveryCodesRemaining != 9 {
		t.Fatal(status)
	}
	third := f.challenge(t)
	_, err = f.svc.VerifyTwoFactorLogin(ctx, third, enabled.RecoveryCodes[0], service.SessionMeta{})
	expectCode(t, err, apperr.CodeAuthTwoFactorInvalid)
	_, err = f.svc.ChangeTwoFactor(ctx, uid, "wrong", enabled.RecoveryCodes[1], false)
	expectCode(t, err, apperr.CodeAuthInvalidCredentials)
	replaced, err := f.svc.ChangeTwoFactor(ctx, uid, "factor-test-password", enabled.RecoveryCodes[1], false)
	if err != nil || len(replaced.RecoveryCodes) != 10 {
		t.Fatal(err)
	}
	_, err = f.svc.VerifyTwoFactorLogin(ctx, third, enabled.RecoveryCodes[2], service.SessionMeta{})
	expectCode(t, err, apperr.CodeAuthTwoFactorInvalid)
	disabled, err := f.svc.ChangeTwoFactor(ctx, uid, "factor-test-password", replaced.RecoveryCodes[0], true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Authenticate(ctx, logged.AccessToken); err == nil {
		t.Fatal("access survived disable")
	}
	if _, err = f.svc.Authenticate(ctx, disabled.Session.AccessToken); err != nil {
		t.Fatal(err)
	}
	r, err := f.svc.Login(ctx, service.LoginInput{Identifier: "factoruser", Password: "factor-test-password"})
	if err != nil || r.AccessToken == "" || r.ChallengeToken != "" {
		t.Fatal("ordinary login", err)
	}
}
func TestTwoFactorExpirationAndLockout(t *testing.T) {
	t.Run("pending setup expires", func(t *testing.T) {
		f := factorServer(t)
		*f.now = f.now.Add(10 * time.Minute)
		_, err := f.svc.EnableTwoFactor(t.Context(), f.initial.User.UID, "factor-test-password", codeAt(t, f.setup.Secret, *f.now))
		expectCode(t, err, apperr.CodeAuthTwoFactorExpired)
	})
	t.Run("challenge expires", func(t *testing.T) {
		f := factorServer(t)
		f.enable(t)
		ch := f.challenge(t)
		*f.now = f.now.Add(5 * time.Minute)
		_, err := f.svc.VerifyTwoFactorLogin(t.Context(), ch, "000000", service.SessionMeta{})
		expectCode(t, err, apperr.CodeAuthTwoFactorExpired)
	})
	t.Run("attempts persist and lock all challenges", func(t *testing.T) {
		f := factorServer(t)
		enabled := f.enable(t)
		ch := f.challenge(t)
		for i := 0; i < 5; i++ {
			_, err := f.svc.VerifyTwoFactorLogin(t.Context(), ch, "invalid", service.SessionMeta{})
			if i < 4 {
				expectCode(t, err, apperr.CodeAuthTwoFactorInvalid)
			} else {
				expectCode(t, err, apperr.CodeAuthTooManyAttempts)
			}
		}
		state, _ := f.repo.Get(t.Context(), f.initial.User.ID, false)
		if state.Challenges[0].Attempts != 5 {
			t.Fatal("attempt rollback")
		}
		_, err := f.svc.VerifyTwoFactorLogin(t.Context(), f.challenge(t), enabled.RecoveryCodes[0], service.SessionMeta{})
		expectCode(t, err, apperr.CodeAuthTooManyAttempts)
	})
	t.Run("challenge invalid after password change", func(t *testing.T) {
		f := factorServer(t)
		enabled := f.enable(t)
		ch := f.challenge(t)
		if err := f.svc.ChangePassword(t.Context(), f.initial.User.UID, "factor-test-password", "another-safe-password", enabled.Session.RefreshToken); err != nil {
			t.Fatal(err)
		}
		_, err := f.svc.VerifyTwoFactorLogin(t.Context(), ch, enabled.RecoveryCodes[0], service.SessionMeta{})
		expectCode(t, err, apperr.CodeAuthTwoFactorExpired)
	})
}
func TestTwoFactorConcurrentConsumption(t *testing.T) {
	f := factorServer(t)
	enabled := f.enable(t)
	ch1, ch2 := f.challenge(t), f.challenge(t)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, ch := range []string{ch1, ch2} {
		wg.Add(1)
		go func(ch string) {
			defer wg.Done()
			_, err := f.svc.VerifyTwoFactorLogin(context.Background(), ch, enabled.RecoveryCodes[0], service.SessionMeta{})
			results <- err
		}(ch)
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("recovery consumed %d times", success)
	}
}

func TestTwoFactorRecoveryWithUnreadableAuthenticator(t *testing.T) {
	f := factorServer(t)
	enabled := f.enable(t)
	challenge := f.challenge(t)
	state, err := f.repo.Get(t.Context(), f.initial.User.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	state.Secret = "unreadable-after-key-rotation"
	if err = f.repo.Save(t.Context(), f.initial.User.ID, state); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.VerifyTwoFactorLogin(t.Context(), challenge, enabled.RecoveryCodes[0], service.SessionMeta{}); err != nil {
		t.Fatalf("independent recovery code must still work: %v", err)
	}
}
