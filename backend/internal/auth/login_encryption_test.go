package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestLoginEnvelope(t *testing.T) {
	a, err := NewLoginCipher("login-encryption-test-secret-123456789")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewLoginCipher("login-encryption-test-secret-123456789")
	if err != nil {
		t.Fatal(err)
	}
	wrong, err := NewLoginCipher("another-encryption-test-secret-123456789")
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := a.SealKey("challenge-account-expiry")
	if err != nil {
		t.Fatal(err)
	}
	encrypt := func(password string, label []byte) string {
		t.Helper()
		data, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &a.key.PublicKey, []byte(password), label)
		if err != nil {
			t.Fatal(err)
		}
		return base64.StdEncoding.EncodeToString(data)
	}
	for _, password := range []string{"existing-password", "中文密码也能登录123", strings.Repeat("a", 72)} {
		ciphertext := encrypt(password, LoginLabel("challenge"))
		if ciphertext == encrypt(password, LoginLabel("challenge")) {
			t.Fatal("OAEP must be randomized")
		}
		plain, err := b.Decrypt(sealed, "challenge-account-expiry", "challenge", ciphertext)
		if err != nil || plain != password {
			t.Fatalf("cross-instance roundtrip failed: %v", err)
		}
	}
	valid := encrypt("existing-password", LoginLabel("challenge"))
	for name, tc := range map[string]struct {
		c                               *LoginCipher
		key, aad, challenge, ciphertext string
	}{
		"wrong environment key": {wrong, sealed, "challenge-account-expiry", "challenge", valid},
		"wrong AAD":             {b, sealed, "other-account", "challenge", valid},
		"wrong challenge":       {b, sealed, "challenge-account-expiry", "other", valid},
		"tampered key":          {b, "bad-key", "challenge-account-expiry", "challenge", valid},
		"tampered ciphertext":   {b, sealed, "challenge-account-expiry", "challenge", strings.Repeat("A", 344)},
		"oversized ciphertext":  {b, sealed, "challenge-account-expiry", "challenge", strings.Repeat("A", 4096)},
		"empty password":        {b, sealed, "challenge-account-expiry", "challenge", encrypt("", LoginLabel("challenge"))},
		"too long password":     {b, sealed, "challenge-account-expiry", "challenge", encrypt(strings.Repeat("a", 73), LoginLabel("challenge"))},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := tc.c.Decrypt(tc.key, tc.aad, tc.challenge, tc.ciphertext); !errors.Is(err, ErrLoginEnvelope) {
				t.Fatalf("invalid envelope: %v", err)
			}
		})
	}
	key := a.PublicKey()
	if key.Kty != "RSA" || key.Alg != "RSA-OAEP-256" || key.E != "AQAB" || len(key.KeyOps) != 1 || key.KeyOps[0] != "encrypt" {
		t.Fatal("unexpected public JWK")
	}
	if _, err := NewLoginCipher("short"); err == nil {
		t.Fatal("short environment key accepted")
	}
}
