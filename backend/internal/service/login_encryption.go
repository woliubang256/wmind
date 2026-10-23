package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

const loginChallengeTTL = 2 * time.Minute

type LoginEncryption struct {
	repo   domain.LoginChallengeRepo
	cipher *auth.LoginCipher
	now    Clock
}

type EncryptedLoginChallenge struct {
	ChallengeID string              `json:"challengeId"`
	PublicKey   auth.LoginPublicKey `json:"publicKey"`
	ExpiresIn   int                 `json:"expiresIn"`
}

func NewLoginEncryption(repo domain.LoginChallengeRepo, secret string) (*LoginEncryption, error) {
	if repo == nil {
		return nil, errors.New("login encryption requires a challenge repository")
	}
	cipher, err := auth.NewLoginCipher(secret)
	if err != nil {
		return nil, err
	}
	return &LoginEncryption{repo: repo, cipher: cipher, now: SystemClock}, nil
}

func loginIdentifierHash(identifier string) string {
	return loginHash(strings.ToLower(strings.TrimSpace(identifier)))
}

func loginHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func loginKeyAAD(hash, identifierHash string, expiry int64) string {
	return fmt.Sprintf("wmind/login/challenge/v1:%s:%s:%d", hash, identifierHash, expiry)
}

func validLoginIdentifier(identifier string) bool {
	return strings.TrimSpace(identifier) != "" && len(identifier) <= 320
}

func invalidLoginChallenge() error { return apperr.New(apperr.CodeAuthLoginChallengeInvalid, "") }

func (s *LoginEncryption) Issue(ctx context.Context, identifier string) (*EncryptedLoginChallenge, error) {
	if !validLoginIdentifier(identifier) {
		return nil, apperr.New(apperr.CodeBadRequest, "")
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	id := base64.RawURLEncoding.EncodeToString(random[:])
	now := s.now().UnixMilli()
	state := domain.LoginChallenge{Hash: loginHash(id), IdentifierHash: loginIdentifierHash(identifier), ExpiresAt: now + loginChallengeTTL.Milliseconds()}
	sealed, err := s.cipher.SealKey(loginKeyAAD(state.Hash, state.IdentifierHash, state.ExpiresAt))
	if err != nil {
		return nil, err
	}
	state.SealedKey = sealed
	if err := s.repo.Create(ctx, state, now); err != nil {
		return nil, err
	}
	return &EncryptedLoginChallenge{ChallengeID: id, PublicKey: s.cipher.PublicKey(), ExpiresIn: int(loginChallengeTTL.Seconds())}, nil
}

// Decrypt consumes the challenge in its own committed operation before password
// verification. Never wrap it in the session transaction: failures must consume it.
func (s *LoginEncryption) Decrypt(ctx context.Context, identifier, challengeID, encryptedPassword string) (string, error) {
	if !validLoginIdentifier(identifier) || len(challengeID) != 43 {
		return "", invalidLoginChallenge()
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challengeID)
	if err != nil || len(decoded) != 32 {
		return "", invalidLoginChallenge()
	}
	state, err := s.repo.Consume(ctx, loginHash(challengeID), loginIdentifierHash(identifier), s.now().UnixMilli())
	if errors.Is(err, domain.ErrNotFound) {
		return "", invalidLoginChallenge()
	}
	if err != nil {
		return "", err
	}
	password, err := s.cipher.Decrypt(state.SealedKey, loginKeyAAD(state.Hash, state.IdentifierHash, state.ExpiresAt), challengeID, encryptedPassword)
	if err != nil {
		return "", invalidLoginChallenge()
	}
	return password, nil
}
