package cloudcreds

import (
	"os"
	"path/filepath"
	"testing"
)

const testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cloud.json")
	creds := Credentials{ServerURL: "https://cloud.example", Identifier: "a@example.test", Email: "a@example.test"}

	if err := Save(path, testSecret, creds, "s3cret-password"); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("文件没有落盘: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("权限应为 0600，实际 %v", info.Mode().Perm())
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if containsPlaintext(raw, "s3cret-password") {
		t.Fatal("密码被明文写进了文件")
	}

	loaded, err := Load(path, testSecret)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if loaded == nil || loaded.ServerURL != creds.ServerURL || loaded.Identifier != creds.Identifier {
		t.Fatalf("读回的内容不对: %+v", loaded)
	}
	password, err := loaded.Decrypt(testSecret)
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	if password != "s3cret-password" {
		t.Fatalf("密码 = %q", password)
	}
}

func TestLoadMissingIsNil(t *testing.T) {
	creds, err := Load(filepath.Join(t.TempDir(), "absent.json"), testSecret)
	if err != nil {
		t.Fatalf("文件不存在不应报错: %v", err)
	}
	if creds != nil {
		t.Fatalf("文件不存在应返回 nil: %+v", creds)
	}
}

// 主密钥变了（比如用户删了 secrets.json）就必须解不开，而不是解出乱码。
func TestDecryptFailsWithWrongSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cloud.json")
	if err := Save(path, testSecret, Credentials{ServerURL: "https://cloud.example", Identifier: "a"}, "pw"); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	other := "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	if _, err := loaded.Decrypt(other); err == nil {
		t.Fatal("换了主密钥应当解密失败")
	}
}

func TestSaveRejectsShortSecret(t *testing.T) {
	if err := Save(filepath.Join(t.TempDir(), "cloud.json"), "short", Credentials{ServerURL: "https://x", Identifier: "a"}, "pw"); err == nil {
		t.Fatal("过短的主密钥应当报错")
	}
}

func TestClear(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cloud.json")
	if err := Save(path, testSecret, Credentials{ServerURL: "https://cloud.example", Identifier: "a"}, "pw"); err != nil {
		t.Fatal(err)
	}
	if err := Clear(path); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if creds, err := Load(path, testSecret); err != nil || creds != nil {
		t.Fatalf("删除后应当读到 nil: %+v %v", creds, err)
	}
	// 重复删除不报错。
	if err := Clear(path); err != nil {
		t.Fatalf("重复删除不应报错: %v", err)
	}
}

func containsPlaintext(raw []byte, needle string) bool {
	return len(needle) > 0 && indexOf(string(raw), needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
