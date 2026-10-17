package auth

import (
	"crypto/rand"
	"fmt"
	"math/big"
)

// GeneratedPasswordLength 是管理员重置密码时随机生成的长度。
//
// 16 位、字符集 57 个符号，熵约 93 位——远超 bcrypt 成本 12 下任何可行爆破。
// 更长的密码只会让管理员抄写时出错。
const GeneratedPasswordLength = 16

// passwordAlphabet 是生成密码用的字符集。
//
// 刻意去掉易混淆的字符（0/O、1/l/I、2/Z、5/S）：管理员往往要把这个密码
// 口头或手抄告诉用户，混淆字符是「明明输对了却登不上」的头号原因。
const passwordAlphabet = "abcdefghijkmnopqrstuvwxyz" +
	"ABCDEFGHJKLMNPQRSTUVWXYZ" +
	"346789" +
	"!@#$%^&*-_=+"

// GeneratePassword 生成一个随机强密码。
//
// 用 crypto/rand 而不是 math/rand：重置后的密码是账号的唯一凭据，可预测的
// 随机数等于没有密码。拒绝采样（rand.Int）天然避免取模偏置。
func GeneratePassword(length int) (string, error) {
	if length <= 0 {
		length = GeneratedPasswordLength
	}
	limit := big.NewInt(int64(len(passwordAlphabet)))
	out := make([]byte, length)
	for i := range out {
		idx, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", fmt.Errorf("生成随机密码: %w", err)
		}
		out[i] = passwordAlphabet[idx.Int64()]
	}
	return string(out), nil
}
