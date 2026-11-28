package openfiles

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestQueueAddReadAndRemove(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "demo.wmind")
	if err := os.WriteFile(path, []byte(`{"format":"wmind"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	q := New()
	var notified []string
	q.OnAdd(func(file File) { notified = append(notified, file.Name) })
	items := q.Add([]string{path, filepath.Join(dir, "ignored.txt")})
	if len(items) != 1 || len(q.List()) != 1 {
		t.Fatalf("accepted=%v queued=%v", items, q.List())
	}
	if len(notified) != 1 || notified[0] != "demo.wmind" {
		t.Fatalf("notifications=%v", notified)
	}
	body, file, err := q.Read(items[0].ID)
	if err != nil || string(body) != `{"format":"wmind"}` || file.Path != path {
		t.Fatalf("read body=%q file=%+v err=%v", body, file, err)
	}
	q.Remove(file.ID)
	if _, _, err := q.Read(file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read removed error=%v", err)
	}
}

func TestQueueReopeningSamePathReplacesItem(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "demo.xmind")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	q := New()
	first := q.Add([]string{path})[0]
	second := q.Add([]string{path})[0]
	items := q.List()
	if len(items) != 1 || items[0].ID != second.ID || items[0].ID == first.ID {
		t.Fatalf("same path was not replaced: first=%+v second=%+v items=%+v", first, second, items)
	}
}

func TestQueueReadRejectsOversizeFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "large.wmind")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(MaxBytes + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	_ = file.Close()
	q := New()
	item := q.Add([]string{path})[0]
	if _, _, err := q.Read(item.ID); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize read error=%v", err)
	}
}

func TestQueueKeepsMissingAssociatedFileForUserFeedback(t *testing.T) {
	q := New()
	item := q.Add([]string{filepath.Join(t.TempDir(), "gone.xmind")})[0]
	if !item.Missing || item.Name != "gone.xmind" {
		t.Fatalf("missing item=%+v", item)
	}
}
