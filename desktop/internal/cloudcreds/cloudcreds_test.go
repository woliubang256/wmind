package cloudcreds

import (
	"strings"
	"testing"
)

const testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestRefreshCredentialIsEncryptedInsteadOfAccountPassword(t *testing.T) {
	creds := Credentials{ServerURL: "https://cloud.example", Identifier: "a", RefreshToken: "sensitive-refresh-credential"}
	raw, err := Encode(creds, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, creds.RefreshToken) || strings.Contains(raw, `"password"`) || strings.Contains(raw, `"accessToken"`) {
		t.Fatal("persisted an account or readable session credential")
	}
	loaded, err := Decode(raw, testSecret)
	if err != nil || loaded.RefreshToken != creds.RefreshToken {
		t.Fatal("refresh credential did not round trip")
	}
	if _, err := Decode(raw, strings.Repeat("f", 64)); err == nil {
		t.Fatal("wrong master key was accepted")
	}
	if _, err := Decode(strings.ReplaceAll(raw, "cloud.example", "other.example"), testSecret); err == nil {
		t.Fatal("ciphertext was rebound to a different server")
	}
	second, err := Encode(creds, testSecret)
	if err != nil || second == raw {
		t.Fatal("encrypted credentials must use a fresh nonce")
	}
}

func TestOldRecordMigratesWithoutKeepingPassword(t *testing.T) {
	for _, token := range []string{"legacy-refresh", ""} {
		legacy := `{"serverUrl":"https://cloud.example","identifier":"a","password":"old-ciphertext","refreshToken":"` + token + `"}`
		loaded, err := Decode(legacy, testSecret)
		if err != nil || loaded.RefreshToken != token {
			t.Fatal("legacy metadata was lost")
		}
		raw, err := Encode(*loaded, testSecret)
		if err != nil || strings.Contains(raw, "password") || strings.Contains(raw, "old-ciphertext") || strings.Contains(raw, "legacy-refresh") {
			t.Fatal("migration kept old password or readable refresh token")
		}
	}
}

func TestSavedSessionRejectsInvalidOrMixedFormats(t *testing.T) {
	for _, raw := range []string{
		`{`, `{}`, `{"serverUrl":"https://x","identifier":"a","version":3}`,
		`{"serverUrl":"https://x","identifier":"a","version":2,"refreshToken":"plaintext"}`,
		`{"serverUrl":"https://x","identifier":"a","version":2,"refreshTokenCiphertext":"broken"}`,
	} {
		if _, err := Decode(raw, testSecret); err == nil {
			t.Fatal("invalid persisted session was accepted")
		}
	}
	if _, err := Encode(Credentials{}, "short"); err == nil {
		t.Fatal("short secret was accepted")
	}
}
