package backup

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRetentionDefaultsAndConfigurationCompatibility(t *testing.T) {
	c := DefaultConfiguration()
	if c.RetainCount != 30 || c.SkipUnchanged {
		t.Fatal("unexpected defaults", c)
	}
	legacy := `{"enabled":false,"cron":"0 3 * * *","timezone":"Asia/Shanghai","target":"webdav","webdav":{},"s3":{}}`
	if err := json.Unmarshal([]byte(legacy), &c); err != nil {
		t.Fatal(err)
	}
	if c.RetainCount != 30 || c.SkipUnchanged || c.Validate(false) != nil {
		t.Fatal("legacy config not upgraded", c)
	}
	for _, count := range []int{-1, 0, 1001} {
		c.RetainCount = count
		if c.Validate(false) == nil {
			t.Fatal("accepted invalid count", count)
		}
	}
	if err := json.Unmarshal([]byte(`{"retainCount":0}`), &c); err != nil {
		t.Fatal(err)
	}
	if c.RetainCount != 0 {
		t.Fatal("explicit zero silently defaulted")
	}
	if err := json.Unmarshal([]byte(`{"retainCount":3,"typo":true}`), &c); err == nil {
		t.Fatal("unknown setting accepted")
	}
	if err := json.Unmarshal([]byte(`{"retainCount":2.5}`), &c); err == nil {
		t.Fatal("fractional count accepted")
	}
}

func TestDefaultTargetUsesS3WithoutReplacingExplicitWebDAV(t *testing.T) {
	c := DefaultConfiguration()
	if c.Target != "s3" || c.Enabled || c.Validate(false) != nil {
		t.Fatal("new configuration must start with disabled S3")
	}
	if c.Validate(true) == nil {
		t.Fatal("unconfigured S3 must not be executable")
	}
	legacy := `{"enabled":false,"cron":"0 3 * * *","timezone":"Asia/Shanghai","target":"webdav","webdav":{"url":"https://backup.example.test"},"s3":{}}`
	if err := json.Unmarshal([]byte(legacy), &c); err != nil {
		t.Fatal(err)
	}
	if c.Target != "webdav" || c.WebDAV.URL != "https://backup.example.test" || c.Validate(false) != nil {
		t.Fatal("explicit legacy WebDAV must be preserved")
	}
	for _, target := range []string{"", "invalid"} {
		c.Target = target
		if c.Validate(false) == nil {
			t.Fatal("invalid target silently defaulted")
		}
	}
}

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
