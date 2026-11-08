package backup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本地目录目标（桌面端离线备份）：Test / Upload / Exists / Delete 都要真的
// 落到文件系统上，并且**不留半截文件**——retention 按文件名统计份数，半截
// 文件会让「保留 30 份」变成假的。

func folderConfig(dir string) Configuration {
	c := DefaultConfiguration()
	c.Target = "folder"
	c.Folder.Dir = dir
	return c
}

func TestFolderTargetRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "backups")
	storage := NewRemoteStorage()
	cfg := folderConfig(dir)

	if err := storage.Test(t.Context(), cfg); err != nil {
		t.Fatalf("连接测试失败: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("连接测试应当创建目录: %v", err)
	}
	// 测试文件必须被清掉：目录里留一个 .tmp 会被误认为半截备份。
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("连接测试留下了文件: %v", entries)
	}

	// 上传一份「备份文件」。
	source := filepath.Join(t.TempDir(), "wmind-20261108T120000Z-ABCDEFGH.zip")
	if err := os.WriteFile(source, []byte("backup-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	name := filepath.Base(source)
	if err := storage.Upload(t.Context(), cfg, name, source); err != nil {
		t.Fatalf("上传失败: %v", err)
	}

	exists, err := storage.Exists(t.Context(), cfg, name)
	if err != nil || !exists {
		t.Fatalf("上传后应当存在: %v %v", exists, err)
	}
	written, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("读不到备份文件: %v", err)
	}
	if string(written) != "backup-bytes" {
		t.Fatalf("内容不对: %q", written)
	}
	info, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("备份文件权限应为 0600，实际 %v", info.Mode().Perm())
	}

	if err := storage.Delete(t.Context(), cfg, name); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	exists, err = storage.Exists(t.Context(), cfg, name)
	if err != nil || exists {
		t.Fatalf("删除后不应存在: %v %v", exists, err)
	}
	// 重复删除不报错（retention 会重复尝试）。
	if err := storage.Delete(t.Context(), cfg, name); err != nil {
		t.Fatalf("重复删除不应报错: %v", err)
	}
}

// 目录不可写时要明确报错，而不是留下一份空备份。
func TestFolderTargetRejectsUnwritableDir(t *testing.T) {
	dir := t.TempDir()
	blocked := filepath.Join(dir, "readonly")
	if err := os.MkdirAll(blocked, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o700) })

	storage := NewRemoteStorage()
	if err := storage.Test(t.Context(), folderConfig(blocked)); err == nil {
		t.Fatal("只读目录应当报错")
	}
}

func TestFolderTargetValidation(t *testing.T) {
	cases := []struct {
		name string
		dir  string
		ok   bool
	}{
		{name: "绝对路径", dir: filepath.Join(string(filepath.Separator), "tmp", "wmind-backups"), ok: true},
		{name: "相对路径", dir: "backups", ok: false},
		// 用字面量而不是 filepath.Join：Join 会先把 ".." 消掉，测不到校验逻辑。
		{name: "含上跳", dir: string(filepath.Separator) + "tmp" + string(filepath.Separator) + ".." + string(filepath.Separator) + "etc", ok: false},
		{name: "根目录", dir: string(filepath.Separator), ok: false},
		{name: "空", dir: "", ok: false},
	}
	for _, tc := range cases {
		c := folderConfig(tc.dir)
		err := c.Validate(true)
		if tc.ok && err != nil {
			t.Fatalf("%s（%q）应当通过校验: %v", tc.name, tc.dir, err)
		}
		if !tc.ok && err == nil {
			t.Fatalf("%s（%q）应当被拒绝", tc.name, tc.dir)
		}
	}
}

// 目标身份必须区分目录：换目录后旧目录的备份不能被当成「自己的」删掉。
func TestFolderTargetIDDependsOnDirectory(t *testing.T) {
	a := targetID(folderConfig(filepath.Join(string(filepath.Separator), "tmp", "a")))
	b := targetID(folderConfig(filepath.Join(string(filepath.Separator), "tmp", "b")))
	if a == b {
		t.Fatal("不同目录应当有不同的目标身份")
	}
	if strings.TrimSpace(a) == "" || strings.TrimSpace(b) == "" {
		t.Fatal("目标身份不能为空")
	}
}
