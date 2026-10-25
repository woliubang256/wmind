package auth

import (
	"strings"
	"testing"
)

func TestSharePasswordCipher(t *testing.T) {
	c, err := NewSharePasswordCipher(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	a, err := c.Encrypt("Ab9x", "share-1", 42)
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Encrypt("Ab9x", "share-1", 42)
	if err != nil {
		t.Fatal(err)
	}
	if a == b || strings.Contains(a, "Ab9x") {
		t.Fatal("ciphertext must be randomized, not plaintext")
	}
	if got, err := c.Decrypt(a, "share-1", 42); err != nil || got != "Ab9x" {
		t.Fatalf("round trip = %q, %v", got, err)
	}
	wrong, _ := NewSharePasswordCipher(strings.Repeat("b", 32))
	for _, tc := range []struct {
		name, value, uid string
		owner            int64
		cipher           *SharePasswordCipher
	}{
		{"share binding", a, "share-2", 42, c},
		{"owner binding", a, "share-1", 43, c},
		{"wrong key", a, "share-1", 42, wrong},
		{"tampered", a[:len(a)-4] + "AAAA", "share-1", 42, c},
		{"truncated", "v1:AA", "share-1", 42, c},
		{"invalid encoding", "v1:!!", "share-1", 42, c},
		{"unknown version", "v2:" + a[3:], "share-1", 42, c},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.cipher.Decrypt(tc.value, tc.uid, tc.owner); err == nil {
				t.Fatal("must reject invalid ciphertext")
			}
		})
	}
	if _, err := NewSharePasswordCipher("short"); err == nil {
		t.Fatal("short key accepted")
	}
	// Reusing the source key for another purpose must not decrypt share data.
	twoFactor, _ := NewTwoFactorCipher(strings.Repeat("a", 32))
	if _, err := twoFactor.Decrypt(a[3:], "share-1:42"); err == nil {
		t.Fatal("encryption purposes are not isolated")
	}
}
