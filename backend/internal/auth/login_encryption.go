package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"math/big"
	"unicode/utf8"
)

var ErrLoginEnvelope = errors.New("invalid login envelope")

// LoginPublicKey is an encrypt-only JWK understood by Web Crypto.
type LoginPublicKey struct {
	Kty    string   `json:"kty"`
	N      string   `json:"n"`
	E      string   `json:"e"`
	Alg    string   `json:"alg"`
	Ext    bool     `json:"ext"`
	KeyOps []string `json:"key_ops"`
}

// LoginCipher seals each challenge's private key for another instance to use.
// Its environment key is purpose-separated from JWT, TOTP and backup encryption.
type LoginCipher struct {
	aead cipher.AEAD
	key  *rsa.PrivateKey
	der  []byte
}

func NewLoginCipher(secret string) (*LoginCipher, error) {
	if len(secret) < 32 {
		return nil, errors.New("login encryption key must contain at least 32 bytes")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("wmind/login/private-key/v1"))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return &LoginCipher{aead: aead, key: key, der: der}, nil
}

func (c *LoginCipher) PublicKey() LoginPublicKey {
	return LoginPublicKey{Kty: "RSA", N: base64.RawURLEncoding.EncodeToString(c.key.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(c.key.E)).Bytes()),
		Alg: "RSA-OAEP-256", Ext: true, KeyOps: []string{"encrypt"}}
}

func (c *LoginCipher) SealKey(aad string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(c.aead.Seal(nonce, nonce, c.der, []byte(aad))), nil
}

func LoginLabel(challenge string) []byte { return []byte("wmind/login/v1:" + challenge) }

func (c *LoginCipher) Decrypt(sealedKey, aad, challenge, ciphertext string) (string, error) {
	// Bound all decoding before allocating or parsing attacker-controlled input.
	if len(sealedKey) > 4096 || len(ciphertext) != 344 {
		return "", ErrLoginEnvelope
	}
	sealed, err := base64.StdEncoding.DecodeString(sealedKey)
	if err != nil || len(sealed) < c.aead.NonceSize() {
		return "", ErrLoginEnvelope
	}
	n := c.aead.NonceSize()
	der, err := c.aead.Open(nil, sealed[:n], sealed[n:], []byte(aad))
	if err != nil {
		return "", ErrLoginEnvelope
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return "", ErrLoginEnvelope
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok || key.N.BitLen() != 2048 || key.E != 65537 {
		return "", ErrLoginEnvelope
	}
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil || len(data) != key.Size() {
		return "", ErrLoginEnvelope
	}
	plain, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, key, data, LoginLabel(challenge))
	if err != nil || len(plain) == 0 || len(plain) > MaxPasswordBytes || !utf8.Valid(plain) {
		return "", ErrLoginEnvelope
	}
	return string(plain), nil
}
