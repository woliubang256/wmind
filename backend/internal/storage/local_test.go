package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalStoreSaveReadDelete(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "uploads")
	store, err := NewLocalStore(dir, "/uploads")
	if err != nil {
		t.Fatalf("NewLocalStore: %v", err)
	}
	ctx := context.Background()

	url, err := store.Save(ctx, "avatar_1.png", []byte("data"))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if url != "/uploads/avatar_1.png" {
		t.Fatalf("URL = %q", url)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "avatar_1.png"))
	if err != nil || string(raw) != "data" {
		t.Fatalf("文件内容 = %q, %v", raw, err)
	}

	if err := store.Delete(ctx, "avatar_1.png"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "avatar_1.png")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("删除后文件仍存在: %v", err)
	}
	// 幂等：再删一次不报错。
	if err := store.Delete(ctx, "avatar_1.png"); err != nil {
		t.Fatalf("重复 Delete: %v", err)
	}
}

func TestLocalStoreRejectsPathTraversal(t *testing.T) {
	store, err := NewLocalStore(t.TempDir(), "/uploads")
	if err != nil {
		t.Fatalf("NewLocalStore: %v", err)
	}
	ctx := context.Background()

	for _, key := range []string{"", ".", "..", "../etc/passwd", "a/b.png", `a\b.png`} {
		if _, err := store.Save(ctx, key, []byte("x")); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("Save(%q) 错误 = %v; 期望 ErrInvalidKey", key, err)
		}
		if err := store.Delete(ctx, key); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("Delete(%q) 错误 = %v; 期望 ErrInvalidKey", key, err)
		}
	}
}

func TestNewLocalStoreCreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "uploads")
	if _, err := NewLocalStore(dir, ""); err != nil {
		t.Fatalf("NewLocalStore: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Fatalf("目录未创建: %v", err)
	}
	if _, err := NewLocalStore("", ""); err == nil {
		t.Fatal("空目录应报错")
	}
}

func TestLocalStoreExistsRejectsMissingSymlinkAndTraversal(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root, "/uploads")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save(t.Context(), "image.png", []byte("image")); err != nil {
		t.Fatal(err)
	}
	if exists, err := store.Exists(t.Context(), "image.png"); !exists || err != nil {
		t.Fatalf("existing=%v,%v", exists, err)
	}
	if exists, err := store.Exists(t.Context(), "missing.png"); exists || err != nil {
		t.Fatalf("missing=%v,%v", exists, err)
	}
	if err := os.Symlink(filepath.Join(root, "image.png"), filepath.Join(root, "link.png")); err != nil {
		t.Fatal(err)
	}
	if exists, err := store.Exists(t.Context(), "link.png"); exists || err != nil {
		t.Fatalf("symlink=%v,%v", exists, err)
	}
	if exists, err := store.Exists(t.Context(), "../image.png"); exists || !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("traversal=%v,%v", exists, err)
	}
}
