package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Access Token 的校验错误。service 层把它们翻译成
// AUTH_TOKEN_EXPIRED / AUTH_TOKEN_INVALID——前端只对前者触发静默刷新。
var (
	ErrTokenExpired = errors.New("访问令牌已过期")
	ErrTokenInvalid = errors.New("访问令牌无效")
)

// tokenIssuerName 是 JWT 的 iss 声明。校验时一并检查，避免同一密钥
// 被复用到别的服务后令牌可以跨服务使用。
const tokenIssuerName = "wmind"

// Claims 是 Access Token 的声明。
//
// 刻意**不含** status：账号被禁用后必须立刻失效，而 JWT 一旦签发就无法
// 收回。用户状态由 RequireAuth 每次查库（带 60 秒缓存，禁用时主动失效），
// 见 docs/04 §2.3。
type Claims struct {
	Role string `json:"role"`
	jwt.RegisteredClaims
}

// TokenIssuer 签发与校验 Access Token。
//
// now 可替换，让测试不必等待真实时间；生产装配走 NewTokenIssuer 的默认值。
type TokenIssuer struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

// NewTokenIssuer 构造签发器。secret 少于 32 字节直接报错：
// HS256 的安全性完全取决于密钥熵，弱密钥等于没有签名。
func NewTokenIssuer(secret string, ttl time.Duration) (*TokenIssuer, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("JWT 密钥至少需要 32 字节，当前 %d 字节", len(secret))
	}
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	return &TokenIssuer{secret: []byte(secret), ttl: ttl, now: time.Now}, nil
}

// TTL 返回 Access Token 的有效期，用于响应里的 expiresIn。
func (i *TokenIssuer) TTL() time.Duration { return i.ttl }

// SetClock 替换时钟。仅用于测试。
func (i *TokenIssuer) SetClock(now func() time.Time) {
	if now != nil {
		i.now = now
	}
}

// Issue 为指定用户签发 Access Token，返回令牌与有效期秒数。
func (i *TokenIssuer) Issue(userUID, role string) (string, int, error) {
	now := i.now().UTC()
	claims := Claims{
		Role: role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userUID,
			Issuer:    tokenIssuerName,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(i.ttl)),
			// jti 让令牌可被单独追踪/拉黑；值本身不需要全局唯一到毫秒，
			// 16 字节随机已远超碰撞概率。
			ID: randomHex(16),
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(i.secret)
	if err != nil {
		return "", 0, fmt.Errorf("签发访问令牌: %w", err)
	}
	return signed, int(i.ttl.Seconds()), nil
}

// Parse 校验令牌并返回声明。
//
// 只接受 HS256：允许 alg 由令牌自己声明（例如 none 或 RS256）是 JWT 最经典
// 的算法混淆漏洞，必须用 WithValidMethods 钉死。
func (i *TokenIssuer) Parse(raw string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) {
		return i.secret, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(tokenIssuerName),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return i.now() }),
	)
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrTokenExpired
		}
		return nil, fmt.Errorf("%w: %v", ErrTokenInvalid, err)
	}
	if claims.Subject == "" {
		return nil, fmt.Errorf("%w: 缺少 sub", ErrTokenInvalid)
	}
	return claims, nil
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 失败意味着系统熵源坏了，此时继续签发可预测的 jti
		// 比直接失败更危险，但也不能让登录整体不可用——退化为空 jti，
		// 由 Parse 的 sub 校验保证令牌本身仍然有效。
		return ""
	}
	return hex.EncodeToString(buf)
}
