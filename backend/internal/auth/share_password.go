package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
)

// SharePasswordCipher reads legacy v1 owner passwords. New share values use plaintext;
// Encrypt remains available for legacy-format fixtures, not the current write path.
type SharePasswordCipher struct{ aead cipher.AEAD }

func NewSharePasswordCipher(secret string) (*SharePasswordCipher, error) {
	if len(secret) < 32 {
		return nil, errors.New("share encryption key must contain at least 32 bytes")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("wmind/share-password/encryption/v1"))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SharePasswordCipher{aead: aead}, nil
}

func sharePasswordAAD(uid string, ownerID int64) []byte {
	return []byte("wmind/share-password/v1/" + strconv.FormatInt(ownerID, 10) + "/" + uid)
}

func (c *SharePasswordCipher) Encrypt(password, uid string, ownerID int64) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(password), sharePasswordAAD(uid, ownerID))
	return "v1:" + base64.RawStdEncoding.EncodeToString(sealed), nil
}

func (c *SharePasswordCipher) Decrypt(value, uid string, ownerID int64) (string, error) {
	encoded, ok := strings.CutPrefix(value, "v1:")
	if !ok {
		return "", errors.New("unknown share password ciphertext version")
	}
	data, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return "", errors.New("invalid share password ciphertext")
	}
	n := c.aead.NonceSize()
	if len(data) < n+c.aead.Overhead() {
		return "", errors.New("invalid share password ciphertext")
	}
	plain, err := c.aead.Open(nil, data[:n], data[n:], sharePasswordAAD(uid, ownerID))
	if err != nil {
		return "", errors.New("cannot decrypt share password")
	}
	return string(plain), nil
}
