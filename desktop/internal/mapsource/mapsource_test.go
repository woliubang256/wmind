package mapsource

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func sourceDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:mapsource-test?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Prepare(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestStoreRoundTripAndByPath(t *testing.T) {
	db := sourceDB(t)
	store := NewStore(db)
	path := filepath.Join(t.TempDir(), "demo.wmind")
	mod := time.Date(2026, 11, 28, 1, 2, 3, 0, time.UTC)
	if err := store.Put(context.Background(), &Record{MapUID: "map-1", Path: path, Size: 42, ModTime: &mod}); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), "map-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != path || got.Name != "demo.wmind" || got.Size != 42 || got.ModTime == nil || !got.ModTime.Equal(mod) {
		t.Fatalf("record=%+v", got)
	}
	byPath, err := store.ByPath(context.Background(), path)
	if err != nil || byPath.MapUID != "map-1" {
		t.Fatalf("by path=%+v err=%v", byPath, err)
	}
}

func TestStoreUpsertMovesSourceAndDeletes(t *testing.T) {
	db := sourceDB(t)
	store := NewStore(db)
	oldPath := filepath.Join(t.TempDir(), "old.wmind")
	newPath := filepath.Join(t.TempDir(), "new.wmind")
	if err := store.Put(context.Background(), &Record{MapUID: "map-1", Path: oldPath}); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), &Record{MapUID: "map-1", Path: newPath}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ByPath(context.Background(), oldPath); err != ErrNotFound {
		t.Fatalf("old path lookup err=%v", err)
	}
	if err := store.Delete(context.Background(), "map-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(context.Background(), "map-1"); err != ErrNotFound {
		t.Fatalf("deleted lookup err=%v", err)
	}
}

func TestStoreSamePathMovesBindingToLatestMap(t *testing.T) {
	db := sourceDB(t)
	store := NewStore(db)
	path := filepath.Join(t.TempDir(), "shared.wmind")
	for _, uid := range []string{"map-old", "map-new"} {
		if err := store.Put(context.Background(), &Record{MapUID: uid, Path: path}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ByPath(context.Background(), path)
	if err != nil || got.MapUID != "map-new" {
		t.Fatalf("same path binding=%+v err=%v", got, err)
	}
	if _, err := store.Get(context.Background(), "map-old"); err != ErrNotFound {
		t.Fatalf("old map source still exists: %v", err)
	}
}
