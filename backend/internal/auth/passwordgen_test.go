package auth_test

import (
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/auth"
)

func TestGeneratePassword(t *testing.T) {
	password, err := auth.GeneratePassword(auth.GeneratedPasswordLength)
	if err != nil {
		t.Fatalf("GeneratePassword: %v", err)
	}
	if len([]rune(password)) != auth.GeneratedPasswordLength {
		t.Fatalf("长度 = %d; 期望 %d", len([]rune(password)), auth.GeneratedPasswordLength)
	}

	// 生成结果必须能过自己的密码策略——否则管理员重置完密码，
	// 用户拿着它去登录又被策略拒掉。
	if err := auth.ValidatePassword(password, auth.DefaultMinPasswordLength); err != nil {
		t.Fatalf("生成的密码没过策略: %v (%q)", err, password)
	}

	// 只允许字母、数字与少量符号；尤其不能出现引号/反斜杠这类
	// 需要转义的字符（管理员要把它贴到聊天窗口里）。
	for _, r := range password {
		if !strings.ContainsRune("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ346789!@#$%^&*-_=+", r) {
			t.Fatalf("出现了字符集之外的字符 %q（密码 %q）", r, password)
		}
	}
}

func TestGeneratePasswordIsRandom(t *testing.T) {
	seen := make(map[string]struct{}, 64)
	for range 64 {
		password, err := auth.GeneratePassword(0) // 0 = 用默认长度
		if err != nil {
			t.Fatalf("GeneratePassword: %v", err)
		}
		if _, ok := seen[password]; ok {
			t.Fatalf("64 次生成出现重复密码 %q——随机源有问题", password)
		}
		seen[password] = struct{}{}
	}
}

func TestGeneratePasswordHonoursLength(t *testing.T) {
	password, err := auth.GeneratePassword(24)
	if err != nil {
		t.Fatalf("GeneratePassword: %v", err)
	}
	if len([]rune(password)) != 24 {
		t.Fatalf("长度 = %d; 期望 24", len([]rune(password)))
	}
}
