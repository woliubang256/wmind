package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 超过上限就滚动：旧内容进 .1，当前文件从头开始，且只保留指定份数。
func TestRotatingWriterRollsOver(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "logs", "wmind.log")
	writer, err := NewRotatingWriter(path, 200, 2)
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer writer.Close()

	line := strings.Repeat("x", 90) + "\n"
	for i := 0; i < 6; i++ {
		if _, err := writer.Write([]byte(line)); err != nil {
			t.Fatalf("写入失败: %v", err)
		}
	}

	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("应当产生 wmind.log.1: %v", err)
	}
	// 超过保留份数的更旧文件必须被清掉。
	if _, err := os.Stat(path + ".3"); err == nil {
		t.Fatal("超出保留份数的备份应当被删除")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("当前日志不存在: %v", err)
	}
	if info.Size() > 200 {
		t.Fatalf("当前日志超过上限: %d", info.Size())
	}
}

// 目录建不出来时退化成 stderr，不返回致命错误——启动流程不能因此中断。
func TestNewFallsBackWhenDirectoryIsUnwritable(t *testing.T) {
	logger, closeLog, err := New(Options{Root: "/dev/null/nope"})
	if logger == nil {
		t.Fatal("应当返回可用的 logger")
	}
	if err == nil {
		t.Fatal("应当返回打开文件的错误供调用方记录")
	}
	logger.Info("still usable")
	closeLog()
}
