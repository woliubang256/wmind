package service

import (
	"context"
	"errors"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

// MediaToken creates a read-only cookie credential, never a reusable refresh
// secret. It is issued alongside, and is revoked with, the exact login session.
func (s *AuthService) MediaToken(result *AuthResult) (string, error) {
	if result == nil || result.RefreshToken == "" {
		return "", apperr.New(apperr.CodeAuthTokenInvalid, "")
	}
	return s.issuer.IssueMedia(auth.HashRefreshToken(result.RefreshToken), result.RefreshExpiresAt)
}

// AuthenticateMedia does not rotate a session or count a refresh attempt.
// Database checks on every read make logout, disable and password revocation
// effective without waiting for a browser cookie or JWT to expire.
func (s *AuthService) AuthenticateMedia(ctx context.Context, raw string) (*domain.User, error) {
	hash, err := s.issuer.ParseMedia(raw)
	if err != nil {
		return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
	}
	stored, err := s.tokens.GetByHash(ctx, hash)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	if !stored.Usable(s.now()) {
		return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
	}
	user, err := s.users.GetByID(ctx, stored.UserID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
		}
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	if user.DeletedAt != nil || !user.IsActive() {
		return nil, apperr.New(apperr.CodeAuthTokenInvalid, "")
	}
	return user, nil
}
