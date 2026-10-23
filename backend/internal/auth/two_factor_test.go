package auth

import (
	"testing"
	"time"
)

func TestTwoFactorCrypto(t *testing.T) {
	c, err := NewTwoFactorCipher("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	value, err := c.Encrypt("secret", "u:active")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := c.Decrypt(value, "u:active")
	if err != nil || plain != "secret" {
		t.Fatalf("round trip: %q %v", plain, err)
	}
	if _, err = c.Decrypt(value, "another:active"); err == nil {
		t.Fatal("cross-user decrypt")
	}
	if _, err = c.Decrypt(value, "u:pending"); err == nil {
		t.Fatal("cross-purpose decrypt")
	}
	if _, err = c.Decrypt(value[:len(value)-3], "u:active"); err == nil {
		t.Fatal("tampered ciphertext")
	}
	// RFC 6238 SHA1 secret at Unix 59 produces 94287082; six digits => 287082.
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	n, ok := MatchTOTP(secret, "287082", time.Unix(59, 0), 0)
	if !ok || n != 1 {
		t.Fatal(n, ok)
	}
	if _, ok = MatchTOTP(secret, "287082", time.Unix(59, 0), 1); ok {
		t.Fatal("replayed counter")
	}
	if _, ok = MatchTOTP(secret, "287082", time.Unix(120, 0), 0); ok {
		t.Fatal("expired code")
	}
	if _, ok = MatchTOTP(secret, "28708x", time.Unix(59, 0), 0); ok {
		t.Fatal("malformed code")
	}
	codes, hashes, err := NewRecoveryCodes()
	if err != nil || len(codes) != 10 || len(hashes) != 10 {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for i, code := range codes {
		if seen[code] || HashRecoveryCode(code) != hashes[i] || code == hashes[i] {
			t.Fatal("bad recovery code")
		}
		seen[code] = true
	}
}
