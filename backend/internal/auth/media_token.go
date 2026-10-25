package auth

import (
	"encoding/hex"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const mediaIssuerName = "wmind-media"

// IssueMedia signs a read-only credential tied to one stored refresh session.
// Its distinct issuer prevents use as either an API access or share token.
func (i *TokenIssuer) IssueMedia(sessionHash string, expiresAt time.Time) (string, error) {
	if !validSessionHash(sessionHash) || !expiresAt.After(i.now()) {
		return "", ErrTokenInvalid
	}
	now := i.now().UTC()
	claims := jwt.RegisteredClaims{
		Issuer: mediaIssuerName, Subject: sessionHash,
		IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(expiresAt),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(i.secret)
}

// ParseMedia only validates the signature and expiry. The caller must also
// verify that the referenced database session and account remain usable.
func (i *TokenIssuer) ParseMedia(raw string) (string, error) {
	claims := &jwt.RegisteredClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) {
		return i.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(mediaIssuerName), jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(i.now))
	if err != nil || !validSessionHash(claims.Subject) {
		return "", fmt.Errorf("%w: invalid media session", ErrTokenInvalid)
	}
	return claims.Subject, nil
}

func validSessionHash(hash string) bool {
	if len(hash) != 64 {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}
