package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// RefreshTokenBytes 是刷新令牌的随机字节数（256 bit）。
//
// 比 Access Token 更长是因为它有效期以天计：熵不足时，攻击者可以离线
// 猜解一个长期有效的凭证。
const RefreshTokenBytes = 32

// NewRefreshToken 生成刷新令牌：返回给客户端的明文与入库的哈希。
//
// 明文用 base64url 无填充编码（43 字符），可以安全地放进 Cookie、
// URL 与 JSON。库里只存 SHA-256：刷新令牌本身是高熵随机串，
// 不需要 bcrypt 那样的慢哈希，SHA-256 足以让拖库者无法反推。
func NewRefreshToken() (plain string, hash string, err error) {
	buf := make([]byte, RefreshTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("生成刷新令牌: %w", err)
	}
	plain = base64.RawURLEncoding.EncodeToString(buf)
	return plain, HashRefreshToken(plain), nil
}

// HashRefreshToken 计算刷新令牌的存储哈希。
//
// 用同一函数处理「入库」与「查询」，避免两处实现不一致导致所有令牌
// 都查不到——这类 bug 的表现是「登录成功后立刻 401」，很难查。
func HashRefreshToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}
