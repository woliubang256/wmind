package service

import (
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/auth"
)

func TestSharePasswordStoredAsReadableValue(t *testing.T) {
	for _, password := range []string{"Ab9x", "v1:custom-code", "plain:custom-code", "分享Ab9"} {
		t.Run(password, func(t *testing.T) {
			f := newShareFixture(t, defaultSharePolicy())
			mapUID, _ := f.seedMap(t, 1, "明文分享码")
			f.svc.passwords = nil // New passwords must not need a legacy decryption key.
			created, err := f.svc.Create(t.Context(), mapUID, 1, CreateShareInput{Password: password})
			if err != nil {
				t.Fatal(err)
			}
			stored := f.shares.rows[0]
			if stored.PasswordCiphertext != "plain:"+password || stored.Password != nil {
				t.Fatal("share password must be stored as a tagged plaintext value")
			}
			if created.Password == nil || *created.Password != password || !auth.VerifyPassword(stored.PasswordHash, password) {
				t.Fatal("owner readback and visitor verification must preserve the exact password")
			}
		})
	}
}

func TestSharePasswordRemainsReadableWithoutOriginalKey(t *testing.T) {
	for _, mode := range []string{"changed-key", "no-legacy-cipher"} {
		t.Run(mode, func(t *testing.T) {
			f := newShareFixture(t, defaultSharePolicy())
			ctx := t.Context()
			mapUID, _ := f.seedMap(t, 1, "反复查看")
			created, err := f.svc.Create(ctx, mapUID, 1, CreateShareInput{Password: "Ab9x"})
			if err != nil {
				t.Fatal(err)
			}
			cipher, _ := auth.NewSharePasswordCipher(strings.Repeat("x", 32))
			if mode == "no-legacy-cipher" {
				cipher = nil
			}
			restarted, err := NewShareService(ShareServiceConfig{
				Shares: f.shares, Maps: f.maps, Policy: defaultSharePolicy(),
				Tokens: f.svc.tokens, Passwords: cipher, Now: f.clock.Now,
			})
			if err != nil {
				t.Fatalf("new share values must not require a legacy cipher: %v", err)
			}
			for read := 0; read < 3; read++ {
				byMap, err := restarted.ListByMap(ctx, mapUID, 1)
				if err != nil || len(byMap) != 1 || byMap[0].Password == nil || *byMap[0].Password != "Ab9x" {
					t.Fatalf("password disappeared on owner read %d after %s: %v", read, mode, err)
				}
				mine, total, err := restarted.ListMine(ctx, 1, "", 1, 20)
				if err != nil || total != 1 || len(mine) != 1 || mine[0].Password == nil || *mine[0].Password != "Ab9x" {
					t.Fatalf("my shares lost the saved password on read %d: %v", read, err)
				}
				access, _, err := restarted.VerifyPassword(ctx, created.Token, "Ab9x")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := restarted.ReadPublic(ctx, created.Token, access, "127.0.0.1"); err != nil {
					t.Fatal(err)
				}
			}
			notes := true
			updated, err := restarted.Update(ctx, created.UID, 1, UpdateShareInput{ShowNotes: &notes})
			if err != nil || updated.Password == nil || *updated.Password != "Ab9x" {
				t.Fatal("an unrelated setting change must preserve the password", err)
			}
			next := "Cd8y"
			updated, err = restarted.Update(ctx, created.UID, 1, UpdateShareInput{Password: &next})
			if err != nil || updated.Password == nil || *updated.Password != next || f.shares.rows[0].PasswordCiphertext != "plain:"+next {
				t.Fatal("reset must save a readable value without the original key", err)
			}
		})
	}
}
