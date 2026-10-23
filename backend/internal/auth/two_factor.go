package auth

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image/png"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// TwoFactorCipher encrypts persistent authenticator secrets using a purpose-separated key.
type TwoFactorCipher struct{ aead cipher.AEAD }

func NewTwoFactorCipher(secret string) (*TwoFactorCipher, error) {
	if len(secret) < 32 {
		return nil, errors.New("2FA encryption key must contain at least 32 bytes")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("wmind/two-factor/encryption/v1"))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &TwoFactorCipher{aead}, nil
}
func (c *TwoFactorCipher) Encrypt(secret, user string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(c.aead.Seal(nonce, nonce, []byte(secret), []byte(user))), nil
}
func (c *TwoFactorCipher) Decrypt(value, user string) (string, error) {
	data, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	n := c.aead.NonceSize()
	if len(data) < n {
		return "", errors.New("invalid encrypted secret")
	}
	plain, err := c.aead.Open(nil, data[:n], data[n:], []byte(user))
	return string(plain), err
}
func NewTwoFactorKey(account string) (secret, uri, qr string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "wmind", AccountName: account, SecretSize: 20, Period: 30, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
	if err != nil {
		return "", "", "", err
	}
	img, err := key.Image(240, 240)
	if err != nil {
		return "", "", "", err
	}
	var buf bytes.Buffer
	if err = png.Encode(&buf, img); err != nil {
		return "", "", "", err
	}
	return key.Secret(), key.URL(), "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// MatchTOTP consumes a time counter, including tolerated clock drift, only once.
func MatchTOTP(secret, code string, now time.Time, last int64) (int64, bool) {
	if len(code) != 6 {
		return 0, false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	for delta := int64(1); delta >= -1; delta-- {
		counter := now.Unix()/30 + delta
		if counter <= last {
			continue
		}
		want, err := totp.GenerateCode(secret, time.Unix(counter*30, 0))
		if err == nil && subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return counter, true
		}
	}
	return 0, false
}
func NormalizeRecoveryCode(value string) string {
	return strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), "-", ""), " ", ""))
}
func HashRecoveryCode(value string) string {
	sum := sha256.Sum256([]byte(NormalizeRecoveryCode(value)))
	return hex.EncodeToString(sum[:])
}
func NewRecoveryCodes() (codes, hashes []string, err error) {
	for i := 0; i < 10; i++ {
		var b [10]byte
		if _, err = rand.Read(b[:]); err != nil {
			return nil, nil, err
		}
		s := hex.EncodeToString(b[:])
		code := s[:5] + "-" + s[5:10] + "-" + s[10:15] + "-" + s[15:]
		codes = append(codes, code)
		hashes = append(hashes, HashRecoveryCode(code))
	}
	return codes, hashes, nil
}
