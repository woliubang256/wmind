package backup

import (
	"strings"
	"testing"
	"time"
)

func TestConfigurationEncryptionAndMasking(t *testing.T) {
	box, err := NewSecretBox(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	c := DefaultConfiguration()
	c.WebDAV.Password = "dav-password"
	c.S3.AccessKey = "access-key"
	c.S3.SecretKey = "secret-key"
	c.S3.SessionToken = "session-token"
	sealed, err := box.Seal(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sealed, "password") {
		t.Fatal("plaintext stored")
	}
	decoded, err := box.Open(sealed)
	if err != nil || decoded != c {
		t.Fatalf("round trip: %+v %v", decoded, err)
	}
	other, _ := NewSecretBox(strings.Repeat("b", 32))
	if _, err = other.Open(sealed); err == nil {
		t.Fatal("wrong key accepted")
	}
	public := c.Public()
	if public.WebDAV.Password != "" || public.S3.AccessKey != "" || public.S3.SecretKey != "" || public.S3.SessionToken != "" {
		t.Fatal("secret exposed")
	}
	if !public.WebDAV.PasswordSet || !public.S3.SecretKeySet {
		t.Fatal("missing secret indicators")
	}
	kept := public.WithSecrets(c)
	if kept.WebDAV.Password != c.WebDAV.Password || kept.S3.SessionToken != c.S3.SessionToken {
		t.Fatal("blank overwrote existing secret")
	}
	public.S3.ClearSessionToken = true
	if public.WithSecrets(c).S3.SessionToken != "" {
		t.Fatal("session token not cleared")
	}
}
func TestCronTimezonesAndInvalidSchedules(t *testing.T) {
	after := time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)
	next, err := Schedule("0 3 * * *", "Asia/Shanghai", after)
	if err != nil {
		t.Fatal(err)
	}
	if len(next) != 5 || next[0].Format(time.RFC3339) != "2026-10-25T03:00:00+08:00" {
		t.Fatal(next)
	}
	for _, expression := range []string{"@daily", "* * * * * *", "60 * * * *", "0 0 31 2 *", "* * bad * *"} {
		if _, err := Schedule(expression, "UTC", after); err == nil {
			t.Fatal("accepted", expression)
		}
	}
	if _, err := Schedule("0 0 * * *", "bad/zone", after); err == nil {
		t.Fatal("accepted bad timezone")
	}
	next, err = Schedule("30 1 * * *", "America/New_York", time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(next); i++ {
		if !next[i].After(next[i-1]) {
			t.Fatal("DST times not monotonic", next)
		}
	}
}
