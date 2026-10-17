// Package auth 提供认证原语：密码哈希与策略、Access Token 签发与校验、
// 刷新令牌的生成与哈希。
//
// 本包只做「密码学与格式」，不含业务规则（谁能登录、注册是否开放），
// 也不依赖数据库、gin 或任何仓储。这样它可以被 service 直接使用，
// 也能被单元测试完整覆盖。
package auth

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// BcryptCost 是密码哈希成本。12 在 2026 年的服务器上约 200–300ms，
// 足以让离线爆破变慢，又不至于让登录接口成为 CPU 放大器。
const BcryptCost = 12

// MaxPasswordBytes 是 bcrypt 的硬上限：超过 72 字节的部分会被静默截断，
// 也就是说 "72 字节 + 任意后缀" 与 "72 字节" 等价。必须在入口拒绝，
// 否则用户以为自己设了更长的密码。
const MaxPasswordBytes = 72

// DefaultMinPasswordLength 是未配置时的最小长度（docs/04 §2.4）。
const DefaultMinPasswordLength = 8

// 密码策略错误。service 层把它们翻译成 VALIDATION_FAILED 并带上字段名。
var (
	ErrPasswordTooShort = errors.New("密码长度不足")
	ErrPasswordTooLong  = errors.New("密码过长")
	ErrPasswordTooWeak  = errors.New("密码过于常见")
)

// HashPassword 用 bcrypt 计算密码哈希。
func HashPassword(plain string) (string, error) {
	if len(plain) > MaxPasswordBytes {
		return "", ErrPasswordTooLong
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), BcryptCost)
	if err != nil {
		return "", fmt.Errorf("bcrypt 计算密码哈希: %w", err)
	}
	return string(hash), nil
}

// VerifyPassword 校验密码是否与哈希匹配。
//
// 返回 bool 而不是 error：调用方对「不匹配」与「哈希损坏」的处理完全相同
// （都是登录失败，且都不能向客户端泄露差异）。
func VerifyPassword(hash, plain string) bool {
	if hash == "" || plain == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// ValidatePassword 按长度与弱密码黑名单校验明文密码。
//
// 不强制大小写/符号组合：那类规则会把人逼成 "Password1!" 这种可预测模式，
// 长度 + 黑名单的防护效果更好（docs/04 §2.4）。
func ValidatePassword(plain string, minLength int) error {
	if minLength <= 0 {
		minLength = DefaultMinPasswordLength
	}
	// 按字符数判断「太短」，按字节数判断 bcrypt 上限：中文密码 8 个字
	// 是 24 字节，长度合规；而 25 个汉字会超过 72 字节，必须拒绝。
	if utf8.RuneCountInString(plain) < minLength {
		return ErrPasswordTooShort
	}
	if len(plain) > MaxPasswordBytes {
		return ErrPasswordTooLong
	}
	if IsWeakPassword(plain) {
		return ErrPasswordTooWeak
	}
	return nil
}

// IsWeakPassword 报告密码是否命中内置弱密码表（忽略大小写与首尾空白）。
//
// 表是 Top-1000 常见密码的第一批（约 120 条）。它是纯数据，扩充不需要
// 改任何调用点；完整 Top-1000 作为后续数据补丁补齐。
func IsWeakPassword(plain string) bool {
	normalized := strings.ToLower(strings.TrimSpace(plain))
	_, weak := weakPasswords[normalized]
	return weak
}

// weakPasswords 是常见弱密码集合。
//
// 用 map 而不是 slice：查表 O(1)，且重复项在编译期就会报错（重复键），
// 比运行时去重更早发现问题。
var weakPasswords = map[string]struct{}{
	"123456": {}, "12345678": {}, "123456789": {}, "1234567890": {}, "1234567": {},
	"password": {}, "password1": {}, "password123": {}, "passw0rd": {}, "p@ssword": {},
	"qwerty": {}, "qwerty123": {}, "qwertyuiop": {}, "abc123": {}, "abcd1234": {},
	"111111": {}, "000000": {}, "121212": {}, "123123": {}, "112233": {},
	"iloveyou": {}, "admin": {}, "admin123": {}, "administrator": {}, "root": {},
	"letmein": {}, "welcome": {}, "welcome1": {}, "monkey": {}, "dragon": {},
	"sunshine": {}, "princess": {}, "football": {}, "baseball": {}, "master": {},
	"shadow": {}, "superman": {}, "batman": {}, "trustno1": {}, "whatever": {},
	"qazwsx": {}, "1q2w3e4r": {}, "1qaz2wsx": {}, "zaq12wsx": {}, "asdfghjkl": {},
	"zxcvbnm": {}, "qweasdzxc": {}, "1q2w3e": {}, "q1w2e3r4": {}, "a1b2c3d4": {},
	"password!": {}, "password@123": {}, "password1234": {}, "pass1234": {}, "test1234": {},
	"changeme": {}, "default": {}, "secret": {}, "secret123": {}, "mypassword": {},
	"wmind": {}, "wmind123": {}, "mindmap": {}, "letmein123": {}, "hello123": {},
	"lovely": {}, "freedom": {}, "flower": {}, "butterfly": {}, "angel": {},
	"computer": {}, "internet": {}, "samsung": {}, "google": {}, "michelle": {},
	"jessica": {}, "charlie": {}, "donald": {}, "michael": {}, "jennifer": {},
	"thomas": {}, "robert": {}, "daniel": {}, "andrew": {}, "joshua": {},
	"summer": {}, "winter": {}, "spring": {}, "autumn": {}, "monday": {},
	"starwars": {}, "pokemon": {}, "naruto": {}, "soccer": {}, "hockey": {},
	"killer": {}, "george": {}, "access": {}, "flower1": {}, "hello": {},
	"hello1234": {}, "test": {}, "test123": {}, "guest": {}, "user": {},
	"temp1234": {}, "temp123": {}, "1234qwer": {}, "qwer1234": {}, "asdf1234": {},
	"asdfgh": {}, "zxcvbn": {}, "qwerty12": {}, "qwerty1234": {}, "iloveyou1": {},
	"666666": {}, "888888": {}, "999999": {}, "5201314": {}, "woaini1314": {},
	"a123456": {}, "a123456789": {}, "abc123456": {}, "123456789a": {}, "123456abc": {},
	"aa123456": {}, "qq123456": {}, "woaini": {}, "nihao": {}, "wang123456": {},
}
