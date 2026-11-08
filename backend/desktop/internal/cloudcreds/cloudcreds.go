// Package cloudcreds 持久化云端连接凭据。
//
// 桌面端要能「记住服务器地址与账号」，否则每次启动都要重填。但密码不能明文
// 落盘：这里用本地主密钥（secrets.json 里的 jwtSecret）派生 AES-GCM 密钥加密，
// 与后端给 AI API Key 的做法一致（docs/03 §4.3）。
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
	"os"
	"path/filepath"
)

// Credentials 是保存在本机的一份云端连接。
type Credentials struct {
	// ServerURL 是自托管服务器地址（已归一化，无尾斜杠）。
	ServerURL string `json:"serverUrl"`
	// Identifier 是登录用的邮箱或用户名。
	Identifier string `json:"identifier"`
	// Email 是登录成功后服务端返回的邮箱，用于界面展示。
	Email string `json:"email,omitempty"`
	// UserUID 是云端用户标识。
	UserUID string `json:"userUid,omitempty"`
	// Role 是云端账号角色（admin / user）。
	Role string `json:"role,omitempty"`
	// Password 是 AES-GCM 加密后的密码（base64）。
	Password string `json:"password"`
	// RefreshToken 是上次登录得到的刷新令牌，便于启动时先试刷新。
	RefreshToken string `json:"refreshToken,omitempty"`
}

// cipherKey 从本地主密钥派生出这份用途专属的密钥。
//
// 派生而不是直接用主密钥：同一把密钥用于多种用途时，一处泄露会牵连全部。
func cipherKey(secret string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("wmind/desktop/cloud-credentials/v1"))
	return mac.Sum(nil)
}

func aead(secret string) (cipher.AEAD, error) {
	block, err := aes.NewCipher(cipherKey(secret))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Save 写入凭据文件（0600）。password 明文只在这里出现一次。
func Save(path, secret string, creds Credentials, password string) error {
	if len(secret) < 32 {
		return errors.New("cloudcreds: secret is too short")
	}
	box, err := aead(secret)
	if err != nil {
		return fmt.Errorf("cloudcreds: %w", err)
	}
	if password != "" {
		nonce := make([]byte, box.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return fmt.Errorf("cloudcreds: nonce: %w", err)
		}
		// Seal(dst, nonce, plaintext, additionalData)：顺序写反会 panic，
		// 报的是「incorrect nonce length」而不是参数错误，很容易看错方向。
		sealed := box.Seal(nil, nonce, []byte(password), nil)
		creds.Password = base64.StdEncoding.EncodeToString(append(nonce, sealed...))
	}
	raw, err := json.Marshal(creds)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("cloudcreds: write %s: %w", path, err)
	}
	return nil
}

// Load 读取凭据；文件不存在时返回 (nil, nil)。
func Load(path, secret string) (*Credentials, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cloudcreds: read %s: %w", path, err)
	}
	var creds Credentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("cloudcreds: parse %s: %w", path, err)
	}
	if creds.ServerURL == "" || creds.Identifier == "" {
		return nil, fmt.Errorf("cloudcreds: %s is incomplete", path)
	}
	return &creds, nil
}

// Decrypt 解开保存的密码。
func (c *Credentials) Decrypt(secret string) (string, error) {
	if c.Password == "" {
		return "", errors.New("cloudcreds: no password stored")
	}
	raw, err := base64.StdEncoding.DecodeString(c.Password)
	if err != nil {
		return "", fmt.Errorf("cloudcreds: decode password: %w", err)
	}
	box, err := aead(secret)
	if err != nil {
		return "", err
	}
	if len(raw) < box.NonceSize() {
		return "", errors.New("cloudcreds: stored password is truncated")
	}
	plain, err := box.Open(nil, raw[:box.NonceSize()], raw[box.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("cloudcreds: decrypt password: %w", err)
	}
	return string(plain), nil
}

// Clear 删除凭据文件（断开连接时调用）。
func Clear(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cloudcreds: remove %s: %w", path, err)
	}
	return nil
}
