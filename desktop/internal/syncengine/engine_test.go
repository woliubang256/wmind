package syncengine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"database/sql"

	_ "modernc.org/sqlite"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

// ── 假的本地仓储 ────────────────────────────────────────────────────────────

type fakeLocal struct {
	maps  map[string]*domain.Map
	owner int64
	clock time.Time
}

func newFakeLocal() *fakeLocal {
	return &fakeLocal{maps: map[string]*domain.Map{}, owner: 1, clock: time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)}
}

func (f *fakeLocal) tick() time.Time {
	f.clock = f.clock.Add(time.Minute)
	return f.clock
}

func (f *fakeLocal) clone(m *domain.Map) *domain.Map {
	cp := *m
	cp.Document = append([]byte(nil), m.Document...)
	return &cp
}

func (f *fakeLocal) GetByUID(_ context.Context, uid string, ownerID int64) (*domain.Map, error) {
	m, ok := f.maps[uid]
	if !ok || m.OwnerID != ownerID || m.DeletedAt != nil {
		return nil, domain.ErrNotFound
	}
	return f.clone(m), nil
}

func (f *fakeLocal) Create(_ context.Context, in domain.CreateMapInput) (*domain.Map, error) {
	if _, exists := f.maps[in.UID]; exists {
		return nil, errors.New("duplicate uid")
	}
	m := &domain.Map{
		ID: int64(len(f.maps) + 1), UID: in.UID, OwnerID: in.OwnerID, Title: in.Title,
		Document: append([]byte(nil), in.Document...), Version: 1,
		NodeCount: in.NodeCount, SizeBytes: in.SizeBytes,
		CreatedAt: in.Now, UpdatedAt: in.Now,
	}
	f.maps[in.UID] = m
	return f.clone(m), nil
}

func (f *fakeLocal) UpdateWithVersion(_ context.Context, in domain.UpdateMapInput) (*domain.Map, error) {
	m, ok := f.maps[in.UID]
	if !ok || m.DeletedAt != nil {
		return nil, domain.ErrNotFound
	}
	if m.Version != in.ExpectedVersion {
		return nil, domain.ErrVersionConflict
	}
	m.Title = in.Title
	m.Document = append([]byte(nil), in.Document...)
	m.Version++
	m.NodeCount = in.NodeCount
	m.SizeBytes = in.SizeBytes
	m.UpdatedAt = in.Now
	return f.clone(m), nil
}

func (f *fakeLocal) SoftDelete(_ context.Context, uid string, ownerID int64, now time.Time) error {
	m, ok := f.maps[uid]
	if !ok || m.OwnerID != ownerID {
		return domain.ErrNotFound
	}
	m.DeletedAt = &now
	m.UpdatedAt = now
	return nil
}

func (f *fakeLocal) ListAllIncludingDeleted(_ context.Context, ownerID int64) ([]*domain.Map, error) {
	var out []*domain.Map
	for _, m := range f.maps {
		if m.OwnerID == ownerID {
			out = append(out, f.clone(m))
		}
	}
	return out, nil
}

// ── 假的云端 ────────────────────────────────────────────────────────────────

type fakeRemote struct {
	maps        map[string]*cloud.Map
	docs        map[string]json.RawMessage
	unavailable bool
	uploads     int
	saves       int
	deletes     int
	clock       time.Time
}

func newFakeRemote() *fakeRemote {
	return &fakeRemote{
		maps: map[string]*cloud.Map{}, docs: map[string]json.RawMessage{},
		clock: time.Date(2026, 11, 8, 9, 30, 0, 0, time.UTC),
	}
}

func (f *fakeRemote) tick() string {
	f.clock = f.clock.Add(time.Minute)
	return f.clock.Format(time.RFC3339Nano)
}

func hashOf(doc []byte) string {
	sum := sha256.Sum256(doc)
	return hex.EncodeToString(sum[:])
}

func (f *fakeRemote) ListChanged(_ context.Context, since time.Time) ([]*cloud.Map, error) {
	if f.unavailable {
		return nil, fmt.Errorf("%w: offline", cloud.ErrUnavailable)
	}
	var out []*cloud.Map
	for _, m := range f.maps {
		at, err := time.Parse(time.RFC3339Nano, m.UpdatedAt)
		if err != nil {
			continue
		}
		if !at.Before(since) {
			cp := *m
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt < out[j].UpdatedAt })
	return out, nil
}

func (f *fakeRemote) GetMap(_ context.Context, uid string) (*cloud.Map, error) {
	m, ok := f.maps[uid]
	if !ok || m.Deleted {
		return nil, cloud.ErrMapNotFound
	}
	cp := *m
	cp.Document = f.docs[uid]
	return &cp, nil
}

func (f *fakeRemote) Upload(_ context.Context, uid, title string, document json.RawMessage) (*cloud.Map, error) {
	if f.unavailable {
		return nil, fmt.Errorf("%w: offline", cloud.ErrUnavailable)
	}
	if _, exists := f.maps[uid]; exists {
		return nil, cloud.ErrUIDConflict
	}
	f.uploads++
	m := &cloud.Map{
		UID: uid, Title: title, Version: 1, DocumentHash: hashOf(document),
		UpdatedAt: f.tick(),
	}
	f.maps[uid] = m
	f.docs[uid] = document
	cp := *m
	return &cp, nil
}

func (f *fakeRemote) Save(_ context.Context, uid string, version int, title string, document json.RawMessage) (*cloud.Map, error) {
	if f.unavailable {
		return nil, fmt.Errorf("%w: offline", cloud.ErrUnavailable)
	}
	m, ok := f.maps[uid]
	if !ok || m.Deleted {
		return nil, cloud.ErrMapNotFound
	}
	if m.Version != version {
		return nil, &cloud.ConflictError{CurrentVersion: m.Version, CurrentHash: m.DocumentHash}
	}
	f.saves++
	m.Title = title
	m.Version++
	m.DocumentHash = hashOf(document)
	m.UpdatedAt = f.tick()
	f.docs[uid] = document
	cp := *m
	return &cp, nil
}

func (f *fakeRemote) Delete(_ context.Context, uid string) error {
	if f.unavailable {
		return fmt.Errorf("%w: offline", cloud.ErrUnavailable)
	}
	m, ok := f.maps[uid]
	if !ok {
		return cloud.ErrMapNotFound
	}
	f.deletes++
	m.Deleted = true
	m.UpdatedAt = f.tick()
	return nil
}

// ── 组装 ────────────────────────────────────────────────────────────────────

func newEngine(t *testing.T) (*Engine, *fakeLocal, *fakeRemote, *syncstate.Store) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "sync.db"))
	if err != nil {
		t.Fatalf("打开数据库: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := syncstate.Prepare(t.Context(), db); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	store := syncstate.NewStore(db)
	local := newFakeLocal()
	remote := newFakeRemote()
	engine := New(local, store, local.owner, slog.New(slog.NewTextHandler(io.Discard, nil)))
	engine.Connect("https://cloud.example", remote)
	return engine, local, remote, store
}

func doc(title string) []byte {
	return []byte(fmt.Sprintf(`{"format":"wmind","title":%q}`, title))
}

func createLocal(t *testing.T, local *fakeLocal, uid, title string) *domain.Map {
	t.Helper()
	created, err := local.Create(t.Context(), domain.CreateMapInput{
		UID: uid, OwnerID: local.owner, Title: title, Document: doc(title),
		NodeCount: 1, SizeBytes: int64(len(doc(title))), Now: local.tick(),
	})
	if err != nil {
		t.Fatalf("本地创建失败: %v", err)
	}
	return created
}

// ── 用例 ────────────────────────────────────────────────────────────────────

func TestUploadBindsRecord(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "本地图")

	record, err := engine.Upload(t.Context(), "map-1")
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if record.RemoteUID != "map-1" || record.BaseVersion != 1 || record.State != syncstate.StateSynced {
		t.Fatalf("绑定结果不对: %+v", record)
	}
	if record.BaseHash == "" || record.BaseLocalHash == "" {
		t.Fatalf("基线摘要缺失: %+v", record)
	}
	if remote.uploads != 1 {
		t.Fatalf("应当只上传一次，实际 %d", remote.uploads)
	}
	stored, err := store.Get(t.Context(), "map-1")
	if err != nil || stored.RemoteURL != "https://cloud.example" {
		t.Fatalf("记录没有落盘: %+v %v", stored, err)
	}
}

func TestPullCreatesLocalCopy(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	// 云端有一张本机没有的图。
	remote.maps["remote-1"] = &cloud.Map{UID: "remote-1", Title: "云端图", Version: 2, DocumentHash: hashOf(doc("云端图")), UpdatedAt: remote.tick()}
	remote.docs["remote-1"] = doc("云端图")

	result, err := engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if result.Pulled != 1 {
		t.Fatalf("应当拉取 1 条，实际 %+v", result)
	}
	got, err := local.GetByUID(t.Context(), "remote-1", local.owner)
	if err != nil {
		t.Fatalf("本地没有创建副本: %v", err)
	}
	if got.Title != "云端图" {
		t.Fatalf("标题不对: %+v", got)
	}
	record, err := store.Get(t.Context(), "remote-1")
	if err != nil || record.BaseVersion != 2 || record.State != syncstate.StateSynced {
		t.Fatalf("记录不对: %+v %v", record, err)
	}

	// 再同步一次：游标已经推进，什么都不该发生。
	result, err = engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("第二次同步失败: %v", err)
	}
	if result.Pulled != 0 || result.Pushed != 0 {
		t.Fatalf("游标没有推进: %+v", result)
	}
}

func TestPullAppliesRemoteUpdate(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "第一版")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}

	// 云端被别的设备改了一次（版本号与摘要都变）。
	remote.maps["map-1"].Version = 2
	remote.maps["map-1"].DocumentHash = hashOf(doc("云端第二版"))
	remote.maps["map-1"].UpdatedAt = remote.tick()
	remote.docs["map-1"] = doc("云端第二版")

	result, err := engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if result.Pulled != 1 {
		t.Fatalf("应当拉取 1 条: %+v", result)
	}
	got, err := local.GetByUID(t.Context(), "map-1", local.owner)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if string(got.Document) != string(doc("云端第二版")) {
		t.Fatalf("本地没有更新: %s", got.Document)
	}
	record, _ := store.Get(t.Context(), "map-1")
	if record.BaseVersion != 2 || record.State != syncstate.StateSynced {
		t.Fatalf("基线没有推进: %+v", record)
	}
}

func TestPushSendsLocalChanges(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "第一版")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}

	// 本地改一次（模拟编辑器保存）。
	current, _ := local.GetByUID(t.Context(), "map-1", local.owner)
	if _, err := local.UpdateWithVersion(t.Context(), domain.UpdateMapInput{
		UID: "map-1", OwnerID: local.owner, Title: "第二版", Document: doc("第二版"),
		NodeCount: 1, SizeBytes: int64(len(doc("第二版"))),
		ExpectedVersion: current.Version, Now: local.tick(),
	}); err != nil {
		t.Fatalf("本地保存失败: %v", err)
	}
	if err := engine.MarkLocalDirty(t.Context(), "map-1"); err != nil {
		t.Fatalf("标记失败: %v", err)
	}

	result, err := engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if result.Pushed != 1 {
		t.Fatalf("应当推送 1 条: %+v", result)
	}
	if remote.maps["map-1"].Version != 2 || string(remote.docs["map-1"]) != string(doc("第二版")) {
		t.Fatalf("云端没有更新: %+v", remote.maps["map-1"])
	}
	record, _ := store.Get(t.Context(), "map-1")
	if record.State != syncstate.StateSynced || record.BaseVersion != 2 {
		t.Fatalf("记录没有回到已同步: %+v", record)
	}
}

func TestBothChangedIsConflict(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "第一版")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}

	// 云端改了。
	remote.maps["map-1"].Version = 2
	remote.maps["map-1"].DocumentHash = hashOf(doc("云端版"))
	remote.maps["map-1"].UpdatedAt = remote.tick()
	remote.docs["map-1"] = doc("云端版")

	// 本地也改了。
	current, _ := local.GetByUID(t.Context(), "map-1", local.owner)
	if _, err := local.UpdateWithVersion(t.Context(), domain.UpdateMapInput{
		UID: "map-1", OwnerID: local.owner, Title: "本地版", Document: doc("本地版"),
		NodeCount: 1, SizeBytes: int64(len(doc("本地版"))),
		ExpectedVersion: current.Version, Now: local.tick(),
	}); err != nil {
		t.Fatalf("本地保存失败: %v", err)
	}

	result, err := engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if len(result.Conflicts) != 1 || result.Conflicts[0] != "map-1" {
		t.Fatalf("应当报一个冲突: %+v", result)
	}
	// 两端内容都不能被覆盖。
	got, _ := local.GetByUID(t.Context(), "map-1", local.owner)
	if string(got.Document) != string(doc("本地版")) {
		t.Fatalf("本地内容被覆盖了: %s", got.Document)
	}
	if string(remote.docs["map-1"]) != string(doc("云端版")) {
		t.Fatalf("云端内容被覆盖了: %s", remote.docs["map-1"])
	}
	record, _ := store.Get(t.Context(), "map-1")
	if record.State != syncstate.StateConflict {
		t.Fatalf("状态应为 conflict: %+v", record)
	}

	// 冲突状态下再同步：不会重复推送，也不会自己解决。
	result, err = engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("第二次同步失败: %v", err)
	}
	if result.Pushed != 0 {
		t.Fatalf("冲突未解决时不应推送: %+v", result)
	}
}

func TestResolveConflictKeepLocalAndKeepRemote(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "第一版")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	remote.maps["map-1"].Version = 2
	remote.maps["map-1"].DocumentHash = hashOf(doc("云端版"))
	remote.maps["map-1"].UpdatedAt = remote.tick()
	remote.docs["map-1"] = doc("云端版")

	current, _ := local.GetByUID(t.Context(), "map-1", local.owner)
	if _, err := local.UpdateWithVersion(t.Context(), domain.UpdateMapInput{
		UID: "map-1", OwnerID: local.owner, Title: "本地版", Document: doc("本地版"),
		NodeCount: 1, SizeBytes: int64(len(doc("本地版"))),
		ExpectedVersion: current.Version, Now: local.tick(),
	}); err != nil {
		t.Fatalf("本地保存失败: %v", err)
	}
	if _, err := engine.Sync(t.Context()); err != nil {
		t.Fatalf("同步失败: %v", err)
	}

	// 保留云端：本地被云端内容覆盖。
	if err := engine.ResolveConflict(t.Context(), "map-1", false); err != nil {
		t.Fatalf("保留云端失败: %v", err)
	}
	got, _ := local.GetByUID(t.Context(), "map-1", local.owner)
	if string(got.Document) != string(doc("云端版")) {
		t.Fatalf("本地没有采用云端内容: %s", got.Document)
	}
	record, _ := store.Get(t.Context(), "map-1")
	if record.State != syncstate.StateSynced {
		t.Fatalf("状态没有回到已同步: %+v", record)
	}

	// 再制造一次冲突，这次保留本地。
	remote.maps["map-1"].Version = 3
	remote.maps["map-1"].DocumentHash = hashOf(doc("云端第三版"))
	remote.maps["map-1"].UpdatedAt = remote.tick()
	remote.docs["map-1"] = doc("云端第三版")
	current, _ = local.GetByUID(t.Context(), "map-1", local.owner)
	if _, err := local.UpdateWithVersion(t.Context(), domain.UpdateMapInput{
		UID: "map-1", OwnerID: local.owner, Title: "本地第三版", Document: doc("本地第三版"),
		NodeCount: 1, SizeBytes: int64(len(doc("本地第三版"))),
		ExpectedVersion: current.Version, Now: local.tick(),
	}); err != nil {
		t.Fatalf("本地保存失败: %v", err)
	}
	if _, err := engine.Sync(t.Context()); err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if err := engine.ResolveConflict(t.Context(), "map-1", true); err != nil {
		t.Fatalf("保留本地失败: %v", err)
	}
	if string(remote.docs["map-1"]) != string(doc("本地第三版")) {
		t.Fatalf("云端没有采用本地内容: %s", remote.docs["map-1"])
	}
}

// 版本号漂移但内容没变不算冲突：别的设备保存了同样的内容。
func TestVersionDriftIsNotConflict(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "第一版")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}

	// 云端版本号变了，但内容与基线一致（摘要不变）。
	remote.maps["map-1"].Version = 5

	current, _ := local.GetByUID(t.Context(), "map-1", local.owner)
	if _, err := local.UpdateWithVersion(t.Context(), domain.UpdateMapInput{
		UID: "map-1", OwnerID: local.owner, Title: "第二版", Document: doc("第二版"),
		NodeCount: 1, SizeBytes: int64(len(doc("第二版"))),
		ExpectedVersion: current.Version, Now: local.tick(),
	}); err != nil {
		t.Fatalf("本地保存失败: %v", err)
	}

	result, err := engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if len(result.Conflicts) != 0 {
		t.Fatalf("版本漂移不应报冲突: %+v", result)
	}
	if result.Pushed != 1 {
		t.Fatalf("应当推送成功: %+v", result)
	}
	record, _ := store.Get(t.Context(), "map-1")
	if record.BaseVersion != 6 {
		t.Fatalf("基线版本 = %d; 期望 6", record.BaseVersion)
	}
}

func TestLocalDeletePushesToRemote(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "要删的图")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if err := local.SoftDelete(t.Context(), "map-1", local.owner, local.tick()); err != nil {
		t.Fatalf("本地删除失败: %v", err)
	}

	result, err := engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if result.Deleted != 1 || remote.deletes != 1 {
		t.Fatalf("删除没有推到云端: %+v deletes=%d", result, remote.deletes)
	}
	record, _ := store.Get(t.Context(), "map-1")
	if !record.Deleted {
		t.Fatalf("记录没有标记为已删除: %+v", record)
	}
}

func TestRemoteDeleteTrashesLocal(t *testing.T) {
	engine, local, remote, _ := newEngine(t)
	createLocal(t, local, "map-1", "云端删掉的图")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if err := remote.Delete(t.Context(), "map-1"); err != nil {
		t.Fatalf("云端删除失败: %v", err)
	}

	result, err := engine.Sync(t.Context())
	if err != nil {
		t.Fatalf("同步失败: %v", err)
	}
	if result.Deleted != 1 {
		t.Fatalf("应当记录一次删除: %+v", result)
	}
	if _, err := local.GetByUID(t.Context(), "map-1", local.owner); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("本地应当进入回收站: %v", err)
	}
	if local.maps["map-1"].DeletedAt == nil {
		t.Fatal("本地没有被标记删除")
	}
}

// 断网时不能推进游标：否则这段时间的变化会被永久跳过。
func TestOfflineKeepsCursor(t *testing.T) {
	engine, local, remote, store := newEngine(t)
	createLocal(t, local, "map-1", "离线图")
	if _, err := engine.Upload(t.Context(), "map-1"); err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if _, err := engine.Sync(t.Context()); err != nil {
		t.Fatalf("首次同步失败: %v", err)
	}
	cursorBefore, _ := store.GetMeta(t.Context(), syncstate.MetaLastPullAt)

	remote.unavailable = true
	if _, err := engine.Sync(t.Context()); !errors.Is(err, cloud.ErrUnavailable) {
		t.Fatalf("断网应返回 ErrUnavailable，实际 %v", err)
	}
	cursorAfter, _ := store.GetMeta(t.Context(), syncstate.MetaLastPullAt)
	if cursorBefore != cursorAfter {
		t.Fatalf("断网时游标不应变化: %q → %q", cursorBefore, cursorAfter)
	}
}

func TestSyncRequiresConnection(t *testing.T) {
	engine, _, _, _ := newEngine(t)
	engine.Disconnect()
	if _, err := engine.Sync(t.Context()); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("未连接应返回 ErrNotConnected，实际 %v", err)
	}
	if _, err := engine.Upload(t.Context(), "map-1"); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("未连接上传应返回 ErrNotConnected，实际 %v", err)
	}
}
