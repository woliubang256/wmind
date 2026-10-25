package auth

import (
	"strings"
	"testing"
	"time"
)

func TestMediaTokenIsIsolatedAndExpires(t *testing.T) {
	issuer, err := NewTokenIssuer(strings.Repeat("s", 32), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	issuer.SetClock(func() time.Time { return now })
	hash := HashRefreshToken("a-test-refresh-token")
	media, err := issuer.IssueMedia(hash, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := issuer.ParseMedia(media); err != nil || got != hash {
		t.Fatalf("media token parse = %q, %v", got, err)
	}
	if _, err := issuer.Parse(media); err == nil {
		t.Fatal("media token accepted as API access token")
	}
	access, _, err := issuer.Issue("test-user", "user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := issuer.ParseMedia(access); err == nil {
		t.Fatal("API token accepted as media token")
	}
	other, _ := NewTokenIssuer(strings.Repeat("x", 32), time.Minute)
	other.SetClock(func() time.Time { return now })
	if _, err := other.ParseMedia(media); err == nil {
		t.Fatal("wrong signing key accepted")
	}
	if _, err := issuer.IssueMedia("not-a-session-hash", now.Add(time.Hour)); err == nil {
		t.Fatal("invalid media subject accepted")
	}
	now = now.Add(2 * time.Hour)
	if _, err := issuer.ParseMedia(media); err == nil {
		t.Fatal("expired media token accepted")
	}
}
