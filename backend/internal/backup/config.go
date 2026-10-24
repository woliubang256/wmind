package backup

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

type WebDAVConfig struct {
	URL         string `json:"url"`
	Username    string `json:"username"`
	Password    string `json:"password,omitempty"`
	PasswordSet bool   `json:"passwordSet,omitempty"`
}
type S3Config struct {
	Endpoint          string `json:"endpoint"`
	Region            string `json:"region"`
	Bucket            string `json:"bucket"`
	Prefix            string `json:"prefix"`
	AccessKey         string `json:"accessKey,omitempty"`
	SecretKey         string `json:"secretKey,omitempty"`
	SessionToken      string `json:"sessionToken,omitempty"`
	AccessKeySet      bool   `json:"accessKeySet,omitempty"`
	SecretKeySet      bool   `json:"secretKeySet,omitempty"`
	SessionTokenSet   bool   `json:"sessionTokenSet,omitempty"`
	ClearSessionToken bool   `json:"clearSessionToken,omitempty"`
	PathStyle         bool   `json:"pathStyle"`
}
type Configuration struct {
	Enabled       bool         `json:"enabled"`
	RetainCount   int          `json:"retainCount"`
	SkipUnchanged bool         `json:"skipUnchanged"`
	Cron          string       `json:"cron"`
	Timezone      string       `json:"timezone"`
	Target        string       `json:"target"`
	WebDAV        WebDAVConfig `json:"webdav"`
	S3            S3Config     `json:"s3"`
}

func DefaultConfiguration() Configuration {
	return Configuration{RetainCount: 30, Cron: "0 3 * * *", Timezone: "Asia/Shanghai", Target: "webdav", S3: S3Config{Region: "us-east-1", Prefix: "wmind", PathStyle: true}}
}

// Default only absent new fields. Explicit zero and unknown fields stay invalid.
func (c *Configuration) UnmarshalJSON(raw []byte) error {
	type plain Configuration
	value := plain{RetainCount: 30}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&value); err != nil {
		return err
	}
	*c = Configuration(value)
	return nil
}
func (c Configuration) Public() Configuration {
	c.WebDAV.PasswordSet = c.WebDAV.Password != ""
	c.WebDAV.Password = ""
	c.S3.AccessKeySet = c.S3.AccessKey != ""
	c.S3.AccessKey = ""
	c.S3.SecretKeySet = c.S3.SecretKey != ""
	c.S3.SecretKey = ""
	c.S3.SessionTokenSet = c.S3.SessionToken != ""
	c.S3.SessionToken = ""
	c.S3.ClearSessionToken = false
	return c
}
func (c Configuration) WithSecrets(old Configuration) Configuration {
	if c.WebDAV.Password == "" {
		c.WebDAV.Password = old.WebDAV.Password
	}
	if c.S3.AccessKey == "" {
		c.S3.AccessKey = old.S3.AccessKey
	}
	if c.S3.SecretKey == "" {
		c.S3.SecretKey = old.S3.SecretKey
	}
	if c.S3.SessionToken == "" && !c.S3.ClearSessionToken {
		c.S3.SessionToken = old.S3.SessionToken
	}
	if c.S3.ClearSessionToken {
		c.S3.SessionToken = ""
	}
	c.S3.ClearSessionToken = false
	c.WebDAV.PasswordSet = false
	c.S3.AccessKeySet = false
	c.S3.SecretKeySet = false
	c.S3.SessionTokenSet = false
	return c
}

var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

func Schedule(expression, zone string, after time.Time) ([]time.Time, error) {
	if len(strings.Fields(expression)) != 5 {
		return nil, errors.New("Cron must contain five fields")
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nil, errors.New("invalid timezone")
	}
	schedule, err := cronParser.Parse(expression)
	if err != nil {
		return nil, errors.New("invalid Cron expression")
	}
	next := after.In(loc)
	result := make([]time.Time, 0, 5)
	for range 5 {
		next = schedule.Next(next)
		if next.IsZero() {
			return nil, errors.New("Cron has no upcoming execution")
		}
		result = append(result, next)
	}
	return result, nil
}
func validEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}
func (c Configuration) Validate(requireTarget bool) error {
	if c.RetainCount < 1 || c.RetainCount > 1000 {
		return errors.New("backup retention must be between 1 and 1000")
	}
	if _, err := Schedule(c.Cron, c.Timezone, time.Now()); err != nil {
		return err
	}
	if c.Target != "webdav" && c.Target != "s3" {
		return errors.New("invalid backup target")
	}
	if !requireTarget {
		return nil
	}
	if c.Target == "webdav" {
		if !validEndpoint(c.WebDAV.URL) {
			return errors.New("invalid WebDAV URL")
		}
		return nil
	}
	if c.S3.Endpoint != "" && !validEndpoint(c.S3.Endpoint) {
		return errors.New("invalid S3 endpoint")
	}
	if c.S3.Bucket == "" || strings.ContainsAny(c.S3.Bucket, "/\\") || c.S3.Region == "" || c.S3.AccessKey == "" || c.S3.SecretKey == "" {
		return errors.New("S3 bucket, region and credentials are required")
	}
	if strings.Contains(c.S3.Prefix, "\\") || strings.Contains(c.S3.Prefix, "..") || strings.HasPrefix(c.S3.Prefix, "/") {
		return errors.New("invalid S3 prefix")
	}
	return nil
}

type SecretBox struct{ aead cipher.AEAD }

func NewSecretBox(secret string) (*SecretBox, error) {
	if len(secret) < 32 {
		return nil, errors.New("backup encryption key must contain at least 32 bytes")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("wmind/backup/credentials/v1"))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	return &SecretBox{aead: aead}, err
}
func (b *SecretBox) Seal(c Configuration) (string, error) {
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := b.aead.Seal(nonce, nonce, raw, []byte("backup.config/v1"))
	out, err := json.Marshal(base64.StdEncoding.EncodeToString(sealed))
	return string(out), err
}
func (b *SecretBox) Open(value string) (Configuration, error) {
	var c Configuration
	var encoded string
	if err := json.Unmarshal([]byte(value), &encoded); err != nil {
		return c, err
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) < b.aead.NonceSize() {
		return c, errors.New("invalid encrypted backup configuration")
	}
	raw, err = b.aead.Open(nil, raw[:b.aead.NonceSize()], raw[b.aead.NonceSize():], []byte("backup.config/v1"))
	if err != nil {
		return c, errors.New("cannot decrypt backup configuration")
	}
	err = json.Unmarshal(raw, &c)
	return c, err
}
