package auth

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestShareTokenBindsCurrentPasswordRevision(t *testing.T) {
	const secret = "share-token-test-secret-long-enough"
	const hash = "$2a$12$opaque-salted-bcrypt-password-hash"
	issuer, err := NewShareTokenIssuer(secret, DefaultShareAccessTTL)
	if err != nil {
		t.Fatal(err)
	}
	access, ttl, err := issuer.Issue("share-1", hash)
	if err != nil || ttl != 1800 {
		t.Fatalf("issue = ttl %d, %v", ttl, err)
	}
	if uid, err := issuer.Parse(access, hash); err != nil || uid != "share-1" {
		t.Fatalf("current revision = %q, %v", uid, err)
	}
	restarted, err := NewShareTokenIssuer(secret, DefaultShareAccessTTL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Parse(access, hash); err != nil {
		t.Fatalf("same key and persisted revision after issuer restart = %v", err)
	}
	parts := strings.Split(access, ".")
	if strings.HasPrefix(parts[2], "A") {
		parts[2] = "B" + parts[2][1:]
	} else {
		parts[2] = "A" + parts[2][1:]
	}
	if _, err := issuer.Parse(strings.Join(parts, "."), hash); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal("tampered signature accepted")
	}
	for _, currentHash := range []string{"different-salted-hash", ""} {
		if _, err := issuer.Parse(access, currentHash); !errors.Is(err, ErrTokenInvalid) {
			t.Fatalf("changed/cleared password = %v; want ErrTokenInvalid", err)
		}
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.Split(access, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), hash) || !strings.Contains(string(payload), `"pv":"`) {
		t.Fatal("password revision must be an opaque fingerprint, not the stored hash")
	}
	if _, _, err := issuer.Issue("", hash); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal("empty share identity accepted")
	}
	if _, _, err := issuer.Issue("share-1", ""); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal("passwordless share access credential issued")
	}
	wrong, err := NewShareTokenIssuer("different-share-secret-long-enough", DefaultShareAccessTTL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrong.Parse(access, hash); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal("wrong signing key accepted")
	}
	loginIssuer, err := NewTokenIssuer(secret, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := loginIssuer.Parse(access); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal("share access credential accepted as login credential")
	}
	loginAccess, _, err := loginIssuer.Issue("user-1", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := issuer.Parse(loginAccess, hash); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal("login credential accepted as share credential")
	}
}

func TestShareTokenRejectsLegacyOrInvalidClaims(t *testing.T) {
	const secret = "share-token-test-secret-long-enough"
	const hash = "salted-password-hash"
	issuer, err := NewShareTokenIssuer(secret, DefaultShareAccessTTL)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	issuer.SetClock(func() time.Time { return now })
	for _, tc := range []struct {
		name string
		edit func(jwt.MapClaims)
		alg  jwt.SigningMethod
	}{
		{"legacy credential without revision", func(c jwt.MapClaims) { delete(c, "pv") }, jwt.SigningMethodHS256},
		{"wrong revision", func(c jwt.MapClaims) { c["pv"] = "wrong-revision" }, jwt.SigningMethodHS256},
		{"transplanted subject", func(c jwt.MapClaims) { c["sub"] = "share-2" }, jwt.SigningMethodHS256},
		{"missing subject", func(c jwt.MapClaims) { delete(c, "sub") }, jwt.SigningMethodHS256},
		{"wrong type", func(c jwt.MapClaims) { c["typ"] = "access" }, jwt.SigningMethodHS256},
		{"wrong issuer", func(c jwt.MapClaims) { c["iss"] = "wmind" }, jwt.SigningMethodHS256},
		{"missing expiry", func(c jwt.MapClaims) { delete(c, "exp") }, jwt.SigningMethodHS256},
		{"expired", func(c jwt.MapClaims) { c["exp"] = now.Add(-time.Second).Unix() }, jwt.SigningMethodHS256},
		{"wrong signing algorithm", func(jwt.MapClaims) {}, jwt.SigningMethodHS384},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := jwt.MapClaims{
				"typ": shareTokenType, "iss": shareIssuerName, "sub": "share-1",
				"pv": issuer.passwordVersion("share-1", hash), "exp": now.Add(time.Hour).Unix(),
			}
			tc.edit(claims)
			raw, err := jwt.NewWithClaims(tc.alg, claims).SignedString([]byte(secret))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := issuer.Parse(raw, hash); err == nil {
				t.Fatal("invalid share credential accepted")
			}
		})
	}
}
