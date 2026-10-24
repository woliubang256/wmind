package integration_test

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
)

type emptySessionStorage struct{}

func (emptySessionStorage) Usage(context.Context) (int64, error) { return 0, nil }

type adminSessionFixture struct {
	db      *sql.DB
	users   domain.UserRepo
	tokens  domain.RefreshTokenRepo
	factor  domain.TwoFactorRepo
	auth    [2]*service.AuthService
	admin   *service.AdminService
	initial *service.AuthResult
	issuer  *auth.TokenIssuer
}

func adminSessions(t *testing.T) *adminSessionFixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sessions.db")
	db, err := sqlite.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := migrate.Up("sqlite", db, logger); err != nil {
		t.Fatal(err)
	}
	otherDB, err := sqlite.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { otherDB.Close() })
	issuer, err := auth.NewTokenIssuer("admin-session-test-secret-at-least-32", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	f := &adminSessionFixture{db: db, issuer: issuer, users: sqlite.NewUserRepository(db), tokens: sqlite.NewRefreshTokenRepository(db), factor: sqlite.NewTwoFactorRepository(db)}
	for i, conn := range []*sql.DB{db, otherDB} {
		f.auth[i], err = service.NewAuthService(sqlite.NewUserRepository(conn), sqlite.NewRefreshTokenRepository(conn), sqlite.NewTxManager(conn), service.AuthServiceConfig{
			Issuer: issuer, TwoFactor: sqlite.NewTwoFactorRepository(conn), TwoFactorKey: "admin-session-test-encryption-secret",
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	f.admin = f.adminWithTokens(t, f.tokens)
	f.initial, err = f.auth[0].Register(t.Context(), service.RegisterInput{Username: "sessionuser", Email: "session@example.test", Password: "session-test-password"})
	if err != nil {
		t.Fatal(err)
	}
	// Authenticate on both instances before the administrator changes anything.
	for _, svc := range f.auth {
		if _, err := svc.Authenticate(t.Context(), f.initial.AccessToken); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *adminSessionFixture) adminWithTokens(t *testing.T, tokens domain.RefreshTokenRepo) *service.AdminService {
	t.Helper()
	svc, err := service.NewAdminService(service.AdminServiceConfig{
		Stats: sqlite.NewAdminStatsRepository(f.db), Uploads: emptySessionStorage{}, Users: f.users,
		Tokens: tokens, Audit: sqlite.NewAuditRepository(f.db), TwoFactor: f.factor,
		Tx: sqlite.NewTxManager(f.db), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func (f *adminSessionFixture) change(t *testing.T, action string) error {
	t.Helper()
	if action == "delete" {
		return f.admin.DeleteUser(t.Context(), f.initial.User.UID, service.Actor{})
	}
	status := domain.UserStatusDisabled
	_, err := f.admin.UpdateUser(t.Context(), f.initial.User.UID, service.AdminUserPatch{Status: &status}, service.Actor{})
	return err
}

func TestAdminSessionsRejectAcrossInstances(t *testing.T) {
	for _, action := range []string{"disable", "delete"} {
		t.Run(action, func(t *testing.T) {
			f := adminSessions(t)
			second, err := f.auth[1].Login(t.Context(), service.LoginInput{Identifier: "sessionuser", Password: "session-test-password"})
			if err != nil {
				t.Fatal(err)
			}
			if err := f.change(t, action); err != nil {
				t.Fatal(err)
			}
			for instance, svc := range f.auth {
				for device, session := range []*service.AuthResult{f.initial, second} {
					if _, err := svc.Authenticate(t.Context(), session.AccessToken); err == nil {
						t.Errorf("instance %d device %d accepted old access token after %s", instance, device, action)
					}
					if _, err := svc.Refresh(t.Context(), session.RefreshToken, service.SessionMeta{}); err == nil {
						t.Errorf("instance %d device %d accepted old refresh token after %s", instance, device, action)
					}
				}
			}
		})
	}
}

func TestAdminSessionsOldTokensDoNotReviveOnEnable(t *testing.T) {
	f := adminSessions(t)
	if err := f.change(t, "disable"); err != nil {
		t.Fatal(err)
	}
	status := domain.UserStatusActive
	if _, err := f.admin.UpdateUser(t.Context(), f.initial.User.UID, service.AdminUserPatch{Status: &status}, service.Actor{}); err != nil {
		t.Fatal(err)
	}
	for instance, svc := range f.auth {
		if _, err := svc.Authenticate(t.Context(), f.initial.AccessToken); err == nil {
			t.Errorf("instance %d revived old access token", instance)
		}
		if _, err := svc.Refresh(t.Context(), f.initial.RefreshToken, service.SessionMeta{}); err == nil {
			t.Errorf("instance %d revived old refresh token", instance)
		}
	}
	fresh, err := f.auth[1].Login(t.Context(), service.LoginInput{Identifier: "sessionuser", Password: "session-test-password"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth[0].Authenticate(t.Context(), fresh.AccessToken); err != nil {
		t.Fatalf("new login rejected: %v", err)
	}
}

func TestAdminSessionsEnablingLegacyDisabledAccountRevokesOldTokens(t *testing.T) {
	f := adminSessions(t)
	// An account disabled by an older binary has no rotated security version.
	if _, err := f.users.UpdateStatus(t.Context(), f.initial.User.UID, domain.UserStatusDisabled, time.Now()); err != nil {
		t.Fatal(err)
	}
	status := domain.UserStatusActive
	if _, err := f.admin.UpdateUser(t.Context(), f.initial.User.UID, service.AdminUserPatch{Status: &status}, service.Actor{}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth[1].Authenticate(t.Context(), f.initial.AccessToken); err == nil {
		t.Error("enabling legacy account revived old access token")
	}
	if _, err := f.auth[1].Refresh(t.Context(), f.initial.RefreshToken, service.SessionMeta{}); err == nil {
		t.Error("enabling legacy account revived old refresh token")
	}
}

type failSessionRevoke struct{ domain.RefreshTokenRepo }

func (failSessionRevoke) RevokeAllForUser(context.Context, int64, time.Time) (int64, error) {
	return 0, errors.New("injected revoke failure")
}

type failSessionVersion struct{ domain.TwoFactorRepo }

func (failSessionVersion) Save(context.Context, int64, *domain.TwoFactorState) error {
	return errors.New("injected version failure")
}

func TestAdminSessionsFailureRollsBackAccount(t *testing.T) {
	for _, failure := range []string{"tokens", "version"} {
		for _, action := range []string{"disable", "delete"} {
			t.Run(action+"/"+failure, func(t *testing.T) {
				f := adminSessions(t)
				tokens := f.tokens
				if failure == "tokens" {
					tokens = failSessionRevoke{f.tokens}
				} else {
					f.factor = failSessionVersion{f.factor}
				}
				f.admin = f.adminWithTokens(t, tokens)
				if err := f.change(t, action); err == nil {
					t.Error("reported success despite failed session revocation")
				}
				user, err := f.users.GetByUID(t.Context(), f.initial.User.UID)
				if err != nil || !user.IsActive() {
					t.Fatalf("account was not rolled back: %v %v", user, err)
				}
				if _, err := f.auth[1].Authenticate(t.Context(), f.initial.AccessToken); err != nil {
					t.Fatalf("rollback invalidated access token: %v", err)
				}
				if _, err := f.auth[1].Refresh(t.Context(), f.initial.RefreshToken, service.SessionMeta{}); err != nil {
					t.Fatalf("rollback invalidated refresh token: %v", err)
				}
			})
		}
	}
}

// Pause before acquiring the real database transaction/security lock, after Login
// has already verified the password and loaded the original active user.
type pausedSessionTx struct {
	domain.TxManager
	entered chan struct{}
	release chan struct{}
}

func (p pausedSessionTx) WithTx(ctx context.Context, fn func(context.Context) error) error {
	close(p.entered)
	select {
	case <-p.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	return p.TxManager.WithTx(ctx, fn)
}

func TestAdminSessionsWaitingLoginCannotBypassDisable(t *testing.T) {
	for _, action := range []string{"disable", "delete"} {
		t.Run(action, func(t *testing.T) {
			f := adminSessions(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			pause := pausedSessionTx{sqlite.NewTxManager(f.db), make(chan struct{}), make(chan struct{})}
			svc, err := service.NewAuthService(f.users, f.tokens, pause, service.AuthServiceConfig{Issuer: f.issuer, TwoFactor: sqlite.NewTwoFactorRepository(f.db), TwoFactorKey: "admin-session-test-encryption-secret"})
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := svc.Login(ctx, service.LoginInput{Identifier: "sessionuser", Password: "session-test-password"})
				done <- err
			}()
			select {
			case <-pause.entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			changeErr := f.change(t, action)
			close(pause.release)
			if changeErr != nil {
				t.Fatal(changeErr)
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("waiting login issued a session for an unavailable account")
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestAdminSessionsWaitingRefreshCannotBypassDisable(t *testing.T) {
	for _, action := range []string{"disable", "delete"} {
		t.Run(action, func(t *testing.T) {
			f := adminSessions(t)
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
			changeErr := f.change(t, action)
			close(pause.release)
			if changeErr != nil {
				t.Fatal(changeErr)
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("waiting refresh issued a session for an unavailable account")
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestAdminSessionsDisablePreservesTwoFactorButClearsChallenges(t *testing.T) {
	f := adminSessions(t)
	uid := f.initial.User.UID
	setup, err := f.auth[0].SetupTwoFactor(t.Context(), uid, "session-test-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth[0].EnableTwoFactor(t.Context(), uid, "session-test-password", codeAt(t, setup.Secret, time.Now())); err != nil {
		t.Fatal(err)
	}
	pending, err := f.auth[1].Login(t.Context(), service.LoginInput{Identifier: "sessionuser", Password: "session-test-password"})
	if err != nil || pending.ChallengeToken == "" {
		t.Fatalf("missing challenge: %v", err)
	}
	before, err := f.factor.Get(t.Context(), f.initial.User.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.change(t, "disable"); err != nil {
		t.Fatal(err)
	}
	status := domain.UserStatusActive
	if _, err := f.admin.UpdateUser(t.Context(), uid, service.AdminUserPatch{Status: &status}, service.Actor{}); err != nil {
		t.Fatal(err)
	}
	after, err := f.factor.Get(t.Context(), f.initial.User.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if !after.Enabled || after.Secret != before.Secret || len(after.RecoveryHashes) != len(before.RecoveryHashes) || len(after.Challenges) != 0 {
		t.Fatal("disable changed 2FA configuration or preserved stale challenges")
	}
	if _, err := f.auth[1].VerifyTwoFactorLogin(t.Context(), pending.ChallengeToken, "000000", service.SessionMeta{}); err == nil {
		t.Fatal("old challenge survived disable and enable")
	}
	fresh, err := f.auth[1].Login(t.Context(), service.LoginInput{Identifier: "sessionuser", Password: "session-test-password"})
	if err != nil || fresh.ChallengeToken == "" || fresh.AccessToken != "" {
		t.Fatalf("new login bypassed 2FA: %v", err)
	}
}
