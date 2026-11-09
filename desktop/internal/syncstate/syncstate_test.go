package syncstate

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sync.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("打开数据库: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Prepare(t.Context(), db); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	// 幂等：桌面端每次启动都会调一次。
	if err := Prepare(t.Context(), db); err != nil {
		t.Fatalf("重复建表应当幂等: %v", err)
	}
	return NewStore(db)
}

func TestPutAndGetRoundTrip(t *testing.T) {
	store := newStore(t)
	synced := time.Date(2026, 11, 8, 10, 30, 0, 500_000_000, time.UTC)

	rec := &Record{
		MapUID: "map-1", RemoteUID: "map-1", RemoteURL: "https://cloud.example",
		BaseVersion: 3, BaseHash: "abc123", LastSyncedAt: &synced, State: StateSynced,
	}
	if err := store.Put(t.Context(), rec); err != nil {
		t.Fatalf("写入失败: %v", err)
	}

	got, err := store.Get(t.Context(), "map-1")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if got.RemoteURL != rec.RemoteURL || got.BaseVersion != 3 || got.BaseHash != "abc123" {
		t.Fatalf("读回的内容不一致: %+v", got)
	}
	if got.LastSyncedAt == nil || !got.LastSyncedAt.Equal(synced) {
		t.Fatalf("最后同步时间丢了精度: %+v", got.LastSyncedAt)
	}
	if got.State != StateSynced {
		t.Fatalf("状态 = %q", got.State)
	}
}

// 覆盖写必须只留一条记录：同步会反复更新同一张导图的状态。
func TestPutUpserts(t *testing.T) {
	store := newStore(t)
	if err := store.Put(t.Context(), &Record{MapUID: "map-1", State: StateLocalOnly}); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(t.Context(), &Record{
		MapUID: "map-1", RemoteUID: "map-1", RemoteURL: "https://cloud.example",
		BaseVersion: 2, State: StateSynced,
	}); err != nil {
		t.Fatal(err)
	}
	all, err := store.List(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("应当只有一条记录，实际 %d", len(all))
	}
	if all[0].State != StateSynced || all[0].BaseVersion != 2 {
		t.Fatalf("覆盖写没有生效: %+v", all[0])
	}
}

func TestGetMissingReturnsErrNotFound(t *testing.T) {
	store := newStore(t)
	if _, err := store.Get(t.Context(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("期望 ErrNotFound，实际 %v", err)
	}
	if _, err := store.ByRemote(t.Context(), "https://cloud.example", "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("按云端反查期望 ErrNotFound，实际 %v", err)
	}
}

func TestByRemote(t *testing.T) {
	store := newStore(t)
	// 本地 uid 与云端 uid 不同：从云端「下载为本地副本」的情形。
	if err := store.Put(t.Context(), &Record{
		MapUID: "local-1", RemoteUID: "remote-1", RemoteURL: "https://cloud.example",
		State: StateSynced,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := store.ByRemote(t.Context(), "https://cloud.example", "remote-1")
	if err != nil {
		t.Fatalf("反查失败: %v", err)
	}
	if got.MapUID != "local-1" {
		t.Fatalf("反查到错误的本地导图: %+v", got)
	}
}

func TestPutRejectsBadInput(t *testing.T) {
	store := newStore(t)
	if err := store.Put(t.Context(), nil); err == nil {
		t.Fatal("nil 记录应当报错")
	}
	if err := store.Put(t.Context(), &Record{}); err == nil {
		t.Fatal("缺少 map uid 应当报错")
	}
	if err := store.Put(t.Context(), &Record{MapUID: "map-1", State: State("weird")}); err == nil {
		t.Fatal("未知状态应当报错")
	}
}

func TestDelete(t *testing.T) {
	store := newStore(t)
	if err := store.Put(t.Context(), &Record{MapUID: "map-1", State: StateLocalOnly}); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete(t.Context(), "map-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(t.Context(), "map-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除后应当读不到: %v", err)
	}
}

// 列表按更新时间升序：同步时先处理更早变动的导图。
func TestListIsOrderedByUpdatedAt(t *testing.T) {
	store := newStore(t)
	later := &Record{MapUID: "later", State: StateLocalOnly, UpdatedAt: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)}
	earlier := &Record{MapUID: "earlier", State: StateLocalOnly, UpdatedAt: time.Date(2026, 11, 8, 11, 0, 0, 0, time.UTC)}
	if err := store.Put(t.Context(), later); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(t.Context(), earlier); err != nil {
		t.Fatal(err)
	}
	all, err := store.List(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].MapUID != "earlier" {
		t.Fatalf("顺序不符合预期: %+v", all)
	}
}
