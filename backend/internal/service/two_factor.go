package service

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

type TwoFactorStatus struct {
	Enabled                bool `json:"enabled"`
	RecoveryCodesRemaining int  `json:"recoveryCodesRemaining"`
}
type TwoFactorSetup struct {
	Secret    string `json:"secret"`
	URI       string `json:"uri"`
	QRCode    string `json:"qrCode"`
	ExpiresIn int    `json:"expiresIn"`
}
type TwoFactorChange struct {
	Session       *AuthResult
	RecoveryCodes []string
}

// Every mutation, login and refresh takes the security-row lock before token locks.
func (s *AuthService) withTwoFactor(ctx context.Context, user *domain.User, fn func(context.Context, *domain.TwoFactorState) error) error {
	return s.tx.WithTx(ctx, func(ctx context.Context) error {
		state := &domain.TwoFactorState{}
		if s.twoFactor != nil {
			if err := s.twoFactor.Ensure(ctx, user.ID); err != nil {
				return err
			}
			var err error
			state, err = s.twoFactor.Get(ctx, user.ID, true)
			if err != nil {
				return err
			}
		}
		// Never issue a session from a user snapshot read before the security lock.
		current, err := s.users.GetByID(ctx, user.ID)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				return apperr.New(apperr.CodeAuthTokenInvalid, "")
			}
			return err
		}
		if !current.IsActive() {
			return apperr.New(apperr.CodeAuthAccountDisabled, "")
		}
		if current.PasswordHash != user.PasswordHash {
			return apperr.New(apperr.CodeAuthTokenInvalid, "")
		}
		*user = *current
		return fn(ctx, state)
	})
}
func (s *AuthService) saveTwoFactor(ctx context.Context, user *domain.User, state *domain.TwoFactorState) error {
	if s.twoFactor == nil {
		return apperr.New(apperr.CodeServiceUnavailable, "")
	}
	return s.twoFactor.Save(ctx, user.ID, state)
}
func (s *AuthService) twoFactorUser(ctx context.Context, uid, password string) (*domain.User, error) {
	if s.twoFactor == nil {
		return nil, apperr.New(apperr.CodeServiceUnavailable, "")
	}
	key := "manage-2fa:" + uid
	if locked, left := s.throttle.Locked(key); locked {
		return nil, tooManyAttempts(left)
	}
	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		return nil, err
	}
	if !auth.VerifyPassword(user.PasswordHash, password) {
		return nil, s.loginFailure(key)
	}
	if !user.IsActive() {
		return nil, apperr.New(apperr.CodeAuthAccountDisabled, "")
	}
	return user, nil
}
func (s *AuthService) TwoFactorStatus(ctx context.Context, uid string) (*TwoFactorStatus, error) {
	if s.twoFactor == nil {
		return nil, apperr.New(apperr.CodeServiceUnavailable, "")
	}
	u, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		return nil, err
	}
	state, err := s.twoFactor.Get(ctx, u.ID, false)
	if err != nil {
		return nil, err
	}
	return &TwoFactorStatus{Enabled: state.Enabled, RecoveryCodesRemaining: len(state.RecoveryHashes)}, nil
}
func (s *AuthService) SetupTwoFactor(ctx context.Context, uid, password string) (*TwoFactorSetup, error) {
	user, err := s.twoFactorUser(ctx, uid, password)
	if err != nil {
		return nil, err
	}
	secret, uri, qr, err := auth.NewTwoFactorKey(user.Email)
	if err != nil {
		return nil, err
	}
	encrypted, err := s.twoFactorCipher.Encrypt(secret, uid+":pending")
	if err != nil {
		return nil, err
	}
	err = s.withTwoFactor(ctx, user, func(ctx context.Context, state *domain.TwoFactorState) error {
		if state.Enabled {
			return apperr.New(apperr.CodeAuthTwoFactorState, "")
		}
		state.PendingSecret = encrypted
		state.PendingExpiresAt = s.now().Add(10 * time.Minute).Unix()
		return s.saveTwoFactor(ctx, user, state)
	})
	if err != nil {
		return nil, err
	}
	return &TwoFactorSetup{Secret: secret, URI: uri, QRCode: qr, ExpiresIn: 600}, nil
}
func (s *AuthService) EnableTwoFactor(ctx context.Context, uid, password, code string) (*TwoFactorChange, error) {
	user, err := s.twoFactorUser(ctx, uid, password)
	if err != nil {
		return nil, err
	}
	result := &TwoFactorChange{}
	err = s.withTwoFactor(ctx, user, func(ctx context.Context, state *domain.TwoFactorState) error {
		if state.Enabled {
			return apperr.New(apperr.CodeAuthTwoFactorState, "")
		}
		if state.PendingSecret == "" || state.PendingExpiresAt <= s.now().Unix() {
			return apperr.New(apperr.CodeAuthTwoFactorExpired, "")
		}
		secret, err := s.twoFactorCipher.Decrypt(state.PendingSecret, uid+":pending")
		if err != nil {
			return err
		}
		counter, ok := auth.MatchTOTP(secret, strings.TrimSpace(code), s.now(), 0)
		if !ok {
			return s.factorFailure("manage-2fa:" + uid)
		}
		state.Secret, err = s.twoFactorCipher.Encrypt(secret, uid+":active")
		if err != nil {
			return err
		}
		result.RecoveryCodes, state.RecoveryHashes, err = auth.NewRecoveryCodes()
		if err != nil {
			return err
		}
		state.Enabled = true
		state.LastCounter = counter
		state.PendingSecret = ""
		state.PendingExpiresAt = 0
		state.Challenges = nil
		return s.rotateTwoFactorSession(ctx, user, state, result)
	})
	if err != nil {
		return nil, err
	}
	s.throttle.Reset("manage-2fa:" + uid)
	return result, nil
}
func (s *AuthService) rotateTwoFactorSession(ctx context.Context, user *domain.User, state *domain.TwoFactorState, result *TwoFactorChange) error {
	version, _, err := auth.NewRefreshToken()
	if err != nil {
		return err
	}
	state.SessionVersion = version
	if err = s.saveTwoFactor(ctx, user, state); err != nil {
		return err
	}
	if _, err = s.tokens.RevokeAllForUser(ctx, user.ID, s.now()); err != nil {
		return err
	}
	result.Session, err = s.issueSession(ctx, user, SessionMeta{Platform: "web"})
	return err
}
func (s *AuthService) verifyFactor(user *domain.User, state *domain.TwoFactorState, code string) (bool, error) {
	code = strings.TrimSpace(code)
	if !state.Enabled {
		return false, nil
	}
	hash := auth.HashRecoveryCode(code)
	for i, stored := range state.RecoveryHashes {
		if subtle.ConstantTimeCompare([]byte(hash), []byte(stored)) == 1 {
			state.RecoveryHashes = append(state.RecoveryHashes[:i], state.RecoveryHashes[i+1:]...)
			return true, nil
		}
	}
	secret, err := s.twoFactorCipher.Decrypt(state.Secret, user.UID+":active")
	if err != nil {
		return false, err
	}
	if counter, ok := auth.MatchTOTP(secret, code, s.now(), state.LastCounter); ok {
		state.LastCounter = counter
		return true, nil
	}

	return false, nil
}
func (s *AuthService) factorFailure(key string) error {
	if locked, left := s.throttle.Fail(key); locked {
		return tooManyAttempts(left)
	}
	return apperr.New(apperr.CodeAuthTwoFactorInvalid, "")
}
func (s *AuthService) ChangeTwoFactor(ctx context.Context, uid, password, code string, disable bool) (*TwoFactorChange, error) {
	user, err := s.twoFactorUser(ctx, uid, password)
	if err != nil {
		return nil, err
	}
	result := &TwoFactorChange{}
	err = s.withTwoFactor(ctx, user, func(ctx context.Context, state *domain.TwoFactorState) error {
		if !state.Enabled {
			return apperr.New(apperr.CodeAuthTwoFactorState, "")
		}
		valid, err := s.verifyFactor(user, state, code)
		if err != nil {
			return err
		}
		if !valid {
			return s.factorFailure("manage-2fa:" + uid)
		}
		if disable {
			state.Enabled = false
			state.Secret = ""
			state.RecoveryHashes = nil
			state.LastCounter = 0
			state.Challenges = nil
			return s.rotateTwoFactorSession(ctx, user, state, result)
		}
		result.RecoveryCodes, state.RecoveryHashes, err = auth.NewRecoveryCodes()
		if err != nil {
			return err
		}
		return s.saveTwoFactor(ctx, user, state)
	})
	if err != nil {
		return nil, err
	}
	s.throttle.Reset("manage-2fa:" + uid)
	return result, nil
}
func (s *AuthService) beginTwoFactorLogin(ctx context.Context, user *domain.User, state *domain.TwoFactorState) (*AuthResult, error) {
	plain, _, err := auth.NewRefreshToken()
	if err != nil {
		return nil, err
	}
	token := user.UID + "." + plain
	now := s.now().Unix()
	out := state.Challenges[:0]
	for _, v := range state.Challenges {
		if v.ExpiresAt > now && v.Attempts < 5 {
			out = append(out, v)
		}
	}
	if len(out) >= 5 {
		out = out[len(out)-4:]
	}
	state.Challenges = append(out, domain.TwoFactorChallenge{Hash: auth.HashRefreshToken(token), PasswordHash: user.PasswordHash, Version: state.SessionVersion, ExpiresAt: now + 300})
	if err = s.saveTwoFactor(ctx, user, state); err != nil {
		return nil, err
	}
	return &AuthResult{ChallengeToken: token, ExpiresIn: 300}, nil
}
func (s *AuthService) VerifyTwoFactorLogin(ctx context.Context, token, code string, meta SessionMeta) (*AuthResult, error) {
	uid, _, ok := strings.Cut(token, ".")
	if !ok || len(token) > 150 || s.twoFactor == nil {
		return nil, apperr.New(apperr.CodeAuthTwoFactorExpired, "")
	}
	key := "login-2fa:" + uid
	if locked, left := s.throttle.Locked(key); locked {
		return nil, tooManyAttempts(left)
	}
	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, apperr.New(apperr.CodeAuthTwoFactorExpired, "")
		}
		return nil, err
	}
	var result *AuthResult
	var rejected error
	err = s.withTwoFactor(ctx, user, func(ctx context.Context, state *domain.TwoFactorState) error {
		if !user.IsActive() {
			return apperr.New(apperr.CodeAuthAccountDisabled, "")
		}
		hash := auth.HashRefreshToken(token)
		idx := -1
		for i, v := range state.Challenges {
			if subtle.ConstantTimeCompare([]byte(v.Hash), []byte(hash)) == 1 {
				idx = i
				break
			}
		}
		if idx < 0 {
			return apperr.New(apperr.CodeAuthTwoFactorExpired, "")
		}
		challenge := &state.Challenges[idx]
		if !state.Enabled || challenge.ExpiresAt <= s.now().Unix() || challenge.Attempts >= 5 || challenge.Version != state.SessionVersion || challenge.PasswordHash != user.PasswordHash {
			return apperr.New(apperr.CodeAuthTwoFactorExpired, "")
		}
		challenge.Attempts++
		valid, err := s.verifyFactor(user, state, code)
		if err != nil {
			return err
		}
		if !valid {
			rejected = s.factorFailure(key)
			return s.saveTwoFactor(ctx, user, state)
		}
		state.Challenges = append(state.Challenges[:idx], state.Challenges[idx+1:]...)
		if err = s.saveTwoFactor(ctx, user, state); err != nil {
			return err
		}
		if err = s.users.TouchLastLogin(ctx, user.ID, s.now()); err != nil {
			return err
		}
		result, err = s.issueSession(ctx, user, meta)
		return err
	})
	if err != nil {
		return nil, err
	}
	if rejected != nil {
		return nil, rejected
	}
	s.throttle.Reset(key)
	return result, nil
}
