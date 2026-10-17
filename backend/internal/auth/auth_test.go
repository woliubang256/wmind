package auth

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestPasswordPolicy(t *testing.T) {
	tests := []struct {
		name    string
		plain   string
		min     int
		wantErr error
	}{
		{"默认长度足够", "correct-horse", 0, nil},
		{"短于默认长度", "short", 0, ErrPasswordTooShort},
		{"短于自定义长度", "abcdefgh", 12, ErrPasswordTooShort},
		{"恰好自定义长度", "abcdefghijkl", 12, nil},
		{"弱密码命中黑名单", "password123", 8, ErrPasswordTooWeak},
		{"弱密码忽略大小写", "PassWord123", 8, ErrPasswordTooWeak},
		{"弱密码忽略首尾空白", "  qwerty  ", 6, ErrPasswordTooWeak},
		{"超过 bcrypt 上限", strings.Repeat("a", 73), 8, ErrPasswordTooLong},
		{"中文按字符计长度", "中文密码足够长", 6, nil},
		{"中文超字节上限", strings.Repeat("密", 25), 8, ErrPasswordTooLong},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePassword(tc.plain, tc.min)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("ValidatePassword(%q, %d) = %v; want %v", tc.plain, tc.min, err, tc.wantErr)
			}
		})
	}
}

func TestHashAndVerifyPassword(t *testing.T) {
	const plain = "a-long-enough-password"

	hash, err := HashPassword(plain)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == plain || len(hash) < 50 {
		t.Fatalf("哈希看起来不对: %q", hash)
	}
	if !VerifyPassword(hash, plain) {
		t.Fatal("正确密码校验失败")
	}
	if VerifyPassword(hash, "another-password") {
		t.Fatal("错误密码竟然通过了校验")
	}
	if VerifyPassword("", plain) || VerifyPassword(hash, "") {
		t.Fatal("空哈希或空密码必须失败")
	}
	// 同一密码两次哈希必须不同（bcrypt 自带盐）。
	second, err := HashPassword(plain)
	if err != nil || second == hash {
		t.Fatalf("两次哈希相同或出错: %q, %v", second, err)
	}
}

func newTestIssuer(t *testing.T) *TokenIssuer {
	t.Helper()
	issuer, err := NewTokenIssuer("test-secret-that-is-long-enough-32b", 15*time.Minute)
	if err != nil {
		t.Fatalf("NewTokenIssuer: %v", err)
	}
	return issuer
}

func TestTokenRoundTrip(t *testing.T) {
	issuer := newTestIssuer(t)
	token, expiresIn, err := issuer.Issue("01JUSER", "admin")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if expiresIn != 900 {
		t.Fatalf("expiresIn = %d; want 900", expiresIn)
	}

	claims, err := issuer.Parse(token)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if claims.Subject != "01JUSER" || claims.Role != "admin" || claims.ID == "" {
		t.Fatalf("claims = %#v", claims)
	}
}

func TestTokenRejectsExpired(t *testing.T) {
	issuer := newTestIssuer(t)
	issuedAt := time.Date(2026, 10, 17, 8, 0, 0, 0, time.UTC)
	issuer.SetClock(func() time.Time { return issuedAt })

	token, _, err := issuer.Issue("01JUSER", "user")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	issuer.SetClock(func() time.Time { return issuedAt.Add(16 * time.Minute) })
	if _, err := issuer.Parse(token); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("过期令牌错误 = %v; want ErrTokenExpired", err)
	}
}

func TestTokenRejectsWrongSecretAndAlg(t *testing.T) {
	issuer := newTestIssuer(t)
	token, _, err := issuer.Issue("01JUSER", "user")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	other, err := NewTokenIssuer("another-secret-that-is-long-enough!", 15*time.Minute)
	if err != nil {
		t.Fatalf("NewTokenIssuer: %v", err)
	}
	if _, err := other.Parse(token); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("换密钥后错误 = %v; want ErrTokenInvalid", err)
	}

	// alg=none 是 JWT 最经典的绕过手法：攻击者把签名段留空。
	noneToken, err := jwt.NewWithClaims(jwt.SigningMethodNone, Claims{
		Role: "admin",
		RegisteredClaims: jwt.RegisteredClaims{
			Subject: "01JATTACKER", Issuer: tokenIssuerName,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("构造 alg=none 令牌: %v", err)
	}
	if _, err := issuer.Parse(noneToken); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("alg=none 令牌错误 = %v; want ErrTokenInvalid", err)
	}
}

func TestNewTokenIssuerRejectsShortSecret(t *testing.T) {
	if _, err := NewTokenIssuer("too-short", time.Minute); err == nil {
		t.Fatal("短密钥必须被拒绝")
	}
}

func TestRefreshTokenGeneration(t *testing.T) {
	plain, hash, err := NewRefreshToken()
	if err != nil {
		t.Fatalf("NewRefreshToken: %v", err)
	}
	if len(plain) < 40 {
		t.Fatalf("明文长度 %d；base64url(32 字节) 应为 43", len(plain))
	}
	if hash == plain || len(hash) != 64 {
		t.Fatalf("哈希应为 64 位十六进制，得到 %q", hash)
	}
	if HashRefreshToken(plain) != hash {
		t.Fatal("HashRefreshToken 与生成时不一致")
	}

	other, otherHash, err := NewRefreshToken()
	if err != nil || other == plain || otherHash == hash {
		t.Fatalf("两次生成不应相同: %q %q, %v", other, otherHash, err)
	}
}
