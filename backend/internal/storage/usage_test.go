package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestUsage(t *testing.T) {
	dir := t.TempDir()
	s, err := NewLocalStore(dir, "/uploads")
	if err != nil {
		t.Fatal(err)
	}
	if n, err := s.Usage(t.Context()); err != nil || n != 0 {
		t.Fatalf("empty = %d %v", n, err)
	}
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"avatar.png": "1234", "nested/image.png": "56789", ".upload-pending": "ignored"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("ignored-link"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if n, err := s.Usage(t.Context()); err != nil || n != 9 {
		t.Fatalf("usage = %d %v; want 9", n, err)
	}
	alias := filepath.Join(t.TempDir(), "uploads-alias")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	aliasStore, err := NewLocalStore(alias, "/uploads")
	if err != nil {
		t.Fatal(err)
	}
	if n, err := aliasStore.Usage(t.Context()); err != nil || n != 9 {
		t.Fatalf("configured root symlink = %d %v; want 9", n, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.Usage(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel = %v", err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Usage(t.Context()); err == nil {
		t.Fatal("missing upload directory must fail")
	}
}
