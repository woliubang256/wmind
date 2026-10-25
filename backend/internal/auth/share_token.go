package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// shareIssuerName 是分享访问令牌的 iss 声明。
//
// 与 Access Token 的 "wmind" **故意不同**：两者用同一个密钥签名，如果 iss
// 也相同，一个分享令牌在结构上就是合法的 Access Token（区别只在 typ 声明，
// 而任何一处忘了检查 typ 的地方都会变成一个提权入口）。换一个 iss 之后，
// 两种令牌在 jwt 库的校验层就互相拒绝，typ 只是第二道锁。
const shareIssuerName = "wmind-share"

// shareTokenType 是 typ 声明的值，与 docs/04 §5.7 的约定一致。
const shareTokenType = "share"

// DefaultShareAccessTTL 是分享访问凭证的有效期。
//
// 30 分钟是「够看完一张导图」与「泄露后窗口够小」之间的折中。它比 Access
// Token 的 15 分钟长，因为分享页的用户没有刷新令牌可用——到期后只能重新
// 输密码，太短会让人在长图里被踢出去。
const DefaultShareAccessTTL = 30 * time.Minute

// ShareClaims 是分享访问令牌的声明。
type ShareClaims struct {
	// Typ 固定为 "share"。
	Typ string `json:"typ"`
	// PasswordVersion is an opaque, keyed fingerprint, never the bcrypt hash.
	PasswordVersion string `json:"pv"`
	jwt.RegisteredClaims
}

// ShareTokenIssuer 签发与校验分享访问令牌。
//
// 它只回答一个问题：「这张分享的密码，在最近 30 分钟内被正确输入过吗」。
// Subject 存的是分享链接的 uid，不是用户——分享页的访客通常没有账号。
type ShareTokenIssuer struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

// NewShareTokenIssuer 构造分享令牌签发器。
func NewShareTokenIssuer(secret string, ttl time.Duration) (*ShareTokenIssuer, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("JWT 密钥至少需要 32 字节，当前 %d 字节", len(secret))
	}
	if ttl <= 0 {
		ttl = DefaultShareAccessTTL
	}
	return &ShareTokenIssuer{secret: []byte(secret), ttl: ttl, now: time.Now}, nil
}

// TTL 返回凭证有效期，用于响应里的 expiresIn。
func (i *ShareTokenIssuer) TTL() time.Duration { return i.ttl }

// SetClock 替换时钟。仅用于测试。
func (i *ShareTokenIssuer) SetClock(now func() time.Time) {
	if now != nil {
		i.now = now
	}
}

// Issue 为指定分享签发访问令牌，返回令牌与有效期秒数。
func (i *ShareTokenIssuer) Issue(shareUID, passwordHash string) (string, int, error) {
	if shareUID == "" || passwordHash == "" {
		return "", 0, fmt.Errorf("%w: 缺少分享或密码版本", ErrTokenInvalid)
	}
	now := i.now().UTC()
	claims := ShareClaims{
		Typ:             shareTokenType,
		PasswordVersion: i.passwordVersion(shareUID, passwordHash),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   shareUID,
			Issuer:    shareIssuerName,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(i.ttl)),
			ID:        randomHex(16),
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(i.secret)
	if err != nil {
		return "", 0, fmt.Errorf("签发分享访问令牌: %w", err)
	}
	return signed, int(i.ttl.Seconds()), nil
}

// Parse 校验令牌与当前密码修订并返回它对应的分享 uid。
//
// 与 Access Token 的 Parse 一样钉死 HS256：允许令牌自己声明 alg 是 JWT 最
// 经典的算法混淆漏洞。
func (i *ShareTokenIssuer) Parse(raw, passwordHash string) (string, error) {
	claims := &ShareClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) {
		return i.secret, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(shareIssuerName),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return i.now() }),
	)
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return "", ErrTokenExpired
		}
		return "", fmt.Errorf("%w: %v", ErrTokenInvalid, err)
	}
	if claims.Typ != shareTokenType {
		return "", fmt.Errorf("%w: typ 不是 share", ErrTokenInvalid)
	}
	if claims.Subject == "" {
		return "", fmt.Errorf("%w: 缺少 sub", ErrTokenInvalid)
	}
	if passwordHash == "" || claims.PasswordVersion == "" || !hmac.Equal([]byte(claims.PasswordVersion), []byte(i.passwordVersion(claims.Subject, passwordHash))) {
		return "", fmt.Errorf("%w: 分享密码版本已失效", ErrTokenInvalid)
	}
	return claims.Subject, nil
}

func (i *ShareTokenIssuer) passwordVersion(shareUID, passwordHash string) string {
	mac := hmac.New(sha256.New, i.secret)
	_, _ = mac.Write([]byte("wmind-share-password-v1\x00" + shareUID + "\x00" + passwordHash))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
