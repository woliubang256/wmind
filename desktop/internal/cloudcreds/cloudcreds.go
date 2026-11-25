// Package cloudcreds encodes native cloud sessions. Only the refresh credential
// is persisted, encrypted with the local master key; account passwords and
// short-lived access tokens are never part of the persisted format.
package cloudcreds

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type Credentials struct {
	ServerURL  string `json:"serverUrl"`
	Identifier string `json:"identifier"`
	Email      string `json:"email,omitempty"`
	UserUID    string `json:"userUid,omitempty"`
	Role       string `json:"role,omitempty"`
	Nickname   string `json:"nickname,omitempty"`
	// Readable only in memory. Encode replaces this legacy field with ciphertext.
	RefreshToken     string    `json:"refreshToken,omitempty"`
	RefreshExpiresAt time.Time `json:"refreshExpiresAt,omitempty"`
}

type storedCredentials struct {
	Credentials
	Version                int    `json:"version"`
	RefreshTokenCiphertext string `json:"refreshTokenCiphertext,omitempty"`
}

func aead(secret string) (cipher.AEAD, error) {
	if len(secret) < 32 {
		return nil, errors.New("cloudcreds: secret is too short")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("wmind/desktop/refresh-credential/v2"))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (c Credentials) associatedData() []byte { return []byte(c.ServerURL + "\x00" + c.Identifier) }

// Encode writes a versioned encrypted credential, including for migrated records.
func Encode(creds Credentials, secret string) (string, error) {
	box, err := aead(secret)
	if err != nil {
		return "", err
	}
	stored := storedCredentials{Credentials: creds, Version: 2}
	stored.RefreshToken = ""
	if creds.RefreshToken != "" {
		nonce := make([]byte, box.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return "", err
		}
		sealed := box.Seal(nil, nonce, []byte(creds.RefreshToken), creds.associatedData())
		stored.RefreshTokenCiphertext = base64.StdEncoding.EncodeToString(append(nonce, sealed...))
	}
	raw, err := json.Marshal(stored)
	return string(raw), err
}

// Decode accepts old refresh credentials for migration, but deliberately ignores
// the old encrypted account password. Missing refresh credentials require login.
func Decode(raw, secret string) (*Credentials, error) {
	var stored storedCredentials
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return nil, errors.New("cloudcreds: invalid saved session")
	}
	if stored.ServerURL == "" || stored.Identifier == "" {
		return nil, errors.New("cloudcreds: credentials are incomplete")
	}
	if stored.Version == 0 && stored.RefreshTokenCiphertext == "" {
		return &stored.Credentials, nil
	}
	if stored.Version != 2 || stored.RefreshToken != "" {
		return nil, errors.New("cloudcreds: unsupported saved session format")
	}
	if stored.RefreshTokenCiphertext == "" {
		return &stored.Credentials, nil
	}
	box, err := aead(secret)
	if err != nil {
		return nil, err
	}
	sealed, err := base64.StdEncoding.DecodeString(stored.RefreshTokenCiphertext)
	if err != nil || len(sealed) < box.NonceSize() {
		return nil, errors.New("cloudcreds: invalid encrypted session")
	}
	plain, err := box.Open(nil, sealed[:box.NonceSize()], sealed[box.NonceSize():], stored.Credentials.associatedData())
	if err != nil {
		return nil, fmt.Errorf("cloudcreds: saved session cannot be decrypted: %w", err)
	}
	stored.RefreshToken = string(plain)
	return &stored.Credentials, nil
}
