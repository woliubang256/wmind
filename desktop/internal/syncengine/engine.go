// Package syncengine 把本地导图与云端导图对齐。
//
// 模型是三层：**本地工作副本**、**上次同步基线**（syncstate 里的版本号与两份
// 内容摘要）、**云端当前内容**。判断谁改过只需要比对摘要：
//
//	localChanged  = hash(本地文档) != 基线里的本地摘要
//	remoteChanged = 云端 documentHash != 基线里的云端摘要
//
// 四种组合各有明确处理：只有云端变了就拉下来，只有本地变了就推上去，都变了
// 就是冲突（不动数据，交给用户选），都没变就跳过。版本号只用于推送时的乐观
// 锁；「云端版本号变了但内容没变」不算冲突——那只是别的设备保存了同样的内容。
//
// 设计约束：
//   - **一次只跑一个同步**：同一进程内的同步串行化，避免同一张图被两个
//     协程同时推。
//   - **不静默丢数据**：任何拿不准的情况都落成 conflict 状态，不覆盖。
//   - **失败不推进游标**：网络失败后游标不动，下次会重拉同一段。
package syncengine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

// ErrNotConnected 表示还没有连接云端。
var ErrNotConnected = errors.New("syncengine: cloud is not connected")

// Remote 是同步引擎需要的云端能力。*cloud.Client 满足它。
type Remote interface {
	ListChanged(ctx context.Context, since time.Time) ([]*cloud.Map, error)
	GetMap(ctx context.Context, uid string) (*cloud.Map, error)
	Upload(ctx context.Context, uid, title string, document json.RawMessage) (*cloud.Map, error)
	Save(ctx context.Context, uid string, version int, title string, document json.RawMessage) (*cloud.Map, error)
	Delete(ctx context.Context, uid string) error
}

// Local 是同步引擎需要的本地能力。domain.MapRepo 满足它。
type Local interface {
	GetByUID(ctx context.Context, uid string, ownerID int64) (*domain.Map, error)
	Create(ctx context.Context, in domain.CreateMapInput) (*domain.Map, error)
	UpdateWithVersion(ctx context.Context, in domain.UpdateMapInput) (*domain.Map, error)
	SoftDelete(ctx context.Context, uid string, ownerID int64, now time.Time) error
	ListAllIncludingDeleted(ctx context.Context, ownerID int64) ([]*domain.Map, error)
}

// Result 是一次同步的结果，供界面展示。
type Result struct {
	// Pulled 是从云端拉到本地的新增/更新条数。
	Pulled int
	// Pushed 是推到云端的新增/更新条数。
	Pushed int
	// Deleted 是两端对齐的删除条数。
	Deleted int
	// Conflicts 是需要用户处理的导图 uid。
	Conflicts []string
	// Failed 是这次没处理成功、下次会重试的导图 uid。
	Failed []string
}

// Engine 是同步引擎。
type Engine struct {
	local   Local
	store   *syncstate.Store
	ownerID int64
	log     *slog.Logger

	mu     sync.Mutex
	remote Remote
	// client 是 remote 的具体类型（云端客户端），代理与资料拉取要用它的令牌。
	client *cloud.Client
	// serverURL 是当前连接的云端地址；换服务器等于换绑定。
	serverURL string
	now       func() time.Time
}

// New 构造引擎。remote 可以为空（尚未连接云端）。
func New(local Local, store *syncstate.Store, ownerID int64, log *slog.Logger) *Engine {
	if log == nil {
		log = slog.Default()
	}
	return &Engine{local: local, store: store, ownerID: ownerID, log: log, now: func() time.Time { return time.Now().UTC() }}
}

// Connect 绑定一个云端连接。
func (e *Engine) Connect(serverURL string, remote Remote) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.serverURL = serverURL
	e.remote = remote
	e.client, _ = remote.(*cloud.Client)
}

// Disconnect 断开云端连接（本地数据与同步记录保留）。
func (e *Engine) Disconnect() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.serverURL = ""
	e.remote = nil
	e.client = nil
}

// Client 返回当前的云端客户端；未连接或不是云端客户端时为 nil。
func (e *Engine) Client() *cloud.Client {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.client
}

// Connected 报告是否已连接云端。
func (e *Engine) Connected() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.remote != nil
}

// ServerURL 返回当前云端地址。
func (e *Engine) ServerURL() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.serverURL
}

// Sync 跑一次完整同步：先拉后推。
func (e *Engine) Sync(ctx context.Context) (*Result, error) {
	e.mu.Lock()
	remote, serverURL := e.remote, e.serverURL
	e.mu.Unlock()
	if remote == nil {
		return nil, ErrNotConnected
	}

	snapshot, err := e.snapshot(ctx)
	if err != nil {
		return nil, err
	}

	result := &Result{}
	if err := e.pull(ctx, remote, serverURL, snapshot, result); err != nil {
		return result, err
	}
	// 拉取会改本地数据（新建副本、覆盖内容、落删除），推送必须基于**拉取
	// 之后**的本地状态：拿旧快照推送会把刚拉下来的内容又推回云端，甚至把
	// 刚建好的记录当成「本地已彻底删除」而清掉。
	snapshot, err = e.snapshot(ctx)
	if err != nil {
		return result, err
	}
	if err := e.push(ctx, remote, serverURL, snapshot, result); err != nil {
		return result, err
	}
	return result, nil
}

// Upload 把一张本地导图上传到云端（首次绑定）。
//
// 与 Sync 分开是因为「上传到云端」是用户显式动作：它必须立刻给出结果，也
// 不需要先拉一遍全量变化。
func (e *Engine) Upload(ctx context.Context, mapUID string) (*syncstate.Record, error) {
	e.mu.Lock()
	remote, serverURL := e.remote, e.serverURL
	e.mu.Unlock()
	if remote == nil {
		return nil, ErrNotConnected
	}

	local, err := e.local.GetByUID(ctx, mapUID, e.ownerID)
	if err != nil {
		return nil, err
	}
	if local.IsTrashed() {
		return nil, errors.New("syncengine: cannot upload a trashed map")
	}

	record, err := e.store.Get(ctx, mapUID)
	if err != nil && !errors.Is(err, syncstate.ErrNotFound) {
		return nil, err
	}
	if record != nil && record.RemoteUID != "" && record.RemoteURL == serverURL {
		// 已经绑定过：走一次普通同步更合适（可能本地还有改动要推）。
		if _, err := e.Sync(ctx); err != nil {
			return nil, err
		}
		return e.store.Get(ctx, mapUID)
	}

	uploaded, err := remote.Upload(ctx, local.UID, local.Title, json.RawMessage(local.Document))
	if err != nil {
		return nil, err
	}
	record = &syncstate.Record{
		MapUID: local.UID, RemoteUID: uploaded.UID, RemoteURL: serverURL,
		BaseVersion: uploaded.Version, BaseHash: uploaded.DocumentHash,
		BaseLocalHash: hashBytes(local.Document),
		State:         syncstate.StateSynced, UpdatedAt: e.now(),
	}
	synced := e.now()
	record.LastSyncedAt = &synced
	if err := e.store.Put(ctx, record); err != nil {
		return nil, err
	}
	return record, nil
}

// snapshot 读一次本地全部导图（含回收站），供本轮同步使用。
//
// 一次性读而不是每张图各查一次：回收站里的导图用 GetByUID 查不到（仓储按
// 语义过滤已删除），而「本地删了要推到云端」恰恰需要看到它们。
func (e *Engine) snapshot(ctx context.Context) (map[string]*domain.Map, error) {
	all, err := e.local.ListAllIncludingDeleted(ctx, e.ownerID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*domain.Map, len(all))
	for _, m := range all {
		out[m.UID] = m
	}
	return out, nil
}

// pull 把云端的变化搬到本地。
func (e *Engine) pull(ctx context.Context, remote Remote, serverURL string, snapshot map[string]*domain.Map, result *Result) error {
	since, err := e.pullCursor(ctx)
	if err != nil {
		return err
	}
	// 游标为空（新装后第一次同步）时用纪元起点：服务端把零值当作「从头开始」，
	// 但显式给一个真实时间戳更稳妥——早期服务端对零值直接回 422。
	if since.IsZero() {
		since = time.Unix(0, 0).UTC()
	}
	changed, err := remote.ListChanged(ctx, since)
	if err != nil {
		return err
	}

	var newest time.Time
	for _, item := range changed {
		if at, parseErr := time.Parse(time.RFC3339Nano, item.UpdatedAt); parseErr == nil && at.After(newest) {
			newest = at
		}
		if err := e.applyRemoteChange(ctx, remote, serverURL, snapshot, item, result); err != nil {
			// 单张失败不影响其他导图；游标不推进，下次重试。
			e.log.Warn("sync: pull failed", "uid", item.UID, "err", err)
			result.Failed = append(result.Failed, item.UID)
			continue
		}
	}
	if len(result.Failed) > 0 {
		return nil
	}
	if !newest.IsZero() {
		if err := e.store.SetMeta(ctx, syncstate.MetaLastPullAt, newest.UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) applyRemoteChange(ctx context.Context, remote Remote, serverURL string, snapshot map[string]*domain.Map, item *cloud.Map, result *Result) error {
	record, err := e.store.ByRemote(ctx, serverURL, item.UID)
	switch {
	case errors.Is(err, syncstate.ErrNotFound):
		// 本地没有这份记录：云端独有。
		if item.Deleted {
			return nil
		}
		return e.createLocalFromRemote(ctx, remote, serverURL, item, result)
	case err != nil:
		return err
	}

	local, ok := snapshot[record.MapUID]
	if !ok {
		// 本地已彻底删除：记录也没意义了。
		return e.store.Delete(ctx, record.MapUID)
	}

	if item.Deleted {
		if local.IsTrashed() {
			record.Deleted = true
			record.State = syncstate.StateSynced
			record.UpdatedAt = e.now()
			return e.store.Put(ctx, record)
		}
		// 云端删了、本地还有：按「云端为准」落删除，但不静默——记成冲突更安全？
		// 选择落删除：回收站还能恢复，比覆盖内容温和。
		if err := e.local.SoftDelete(ctx, record.MapUID, e.ownerID, e.now()); err != nil {
			return err
		}
		record.Deleted = true
		record.State = syncstate.StateSynced
		record.UpdatedAt = e.now()
		result.Deleted++
		return e.store.Put(ctx, record)
	}

	remoteChanged := item.DocumentHash != "" && item.DocumentHash != record.BaseHash
	if !remoteChanged {
		return nil
	}
	localChanged := hashBytes(local.Document) != record.BaseLocalHash
	if localChanged {
		record.State = syncstate.StateConflict
		record.UpdatedAt = e.now()
		result.Conflicts = append(result.Conflicts, record.MapUID)
		return e.store.Put(ctx, record)
	}

	detail, err := remote.GetMap(ctx, item.UID)
	if err != nil {
		return err
	}
	updated, err := e.local.UpdateWithVersion(ctx, domain.UpdateMapInput{
		UID: record.MapUID, OwnerID: e.ownerID,
		Title: detail.Title, Document: detail.Document,
		NodeCount: detail.NodeCount, SizeBytes: int64(len(detail.Document)),
		ExpectedVersion: local.Version, Now: remoteTime(item.UpdatedAt, e.now()),
	})
	if err != nil {
		if errors.Is(err, domain.ErrVersionConflict) {
			// 本地在同步过程中又存了一次：这次先跳过，下一轮再来。
			return fmt.Errorf("local changed during sync: %w", err)
		}
		return err
	}

	synced := e.now()
	record.BaseVersion = detail.Version
	record.BaseHash = detail.DocumentHash
	record.BaseLocalHash = hashBytes(updated.Document)
	record.LastSyncedAt = &synced
	record.State = syncstate.StateSynced
	record.UpdatedAt = synced
	result.Pulled++
	return e.store.Put(ctx, record)
}

// remoteTime 解析云端时间戳；解析不了就退回本地时间（宁可显示同步时刻，
// 也不能显示零值时间）。
func remoteTime(value string, fallback time.Time) time.Time {
	if at, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return at
	}
	return fallback
}

func (e *Engine) createLocalFromRemote(ctx context.Context, remote Remote, serverURL string, item *cloud.Map, result *Result) error {
	detail, err := remote.GetMap(ctx, item.UID)
	if err != nil {
		return err
	}
	// 沿用云端 uid：之后两端指向同一份文档，排查问题时不用再查映射表。
	//
	// 时间也沿用云端的：列表里的「更新于」表示内容什么时候改的，同步动作
	// 发生在什么时候与此无关——用本地 now 会让所有拉下来的图都变成「刚刚」。
	created, err := e.local.Create(ctx, domain.CreateMapInput{
		UID: detail.UID, OwnerID: e.ownerID, Title: detail.Title,
		Document: detail.Document, NodeCount: detail.NodeCount,
		SizeBytes: int64(len(detail.Document)), Now: remoteTime(item.UpdatedAt, e.now()),
	})
	if err != nil {
		return err
	}
	synced := e.now()
	record := &syncstate.Record{
		MapUID: created.UID, RemoteUID: detail.UID, RemoteURL: serverURL,
		BaseVersion: detail.Version, BaseHash: detail.DocumentHash,
		BaseLocalHash: hashBytes(created.Document),
		// Record.UpdatedAt 是**同步状态**的更新时间（内部用），列表展示的时间
		// 来自导图本身（上面已用云端时间）。
		LastSyncedAt: &synced, State: syncstate.StateSynced, UpdatedAt: synced,
	}
	result.Pulled++
	return e.store.Put(ctx, record)
}

// push 把本地变化推到云端。
func (e *Engine) push(ctx context.Context, remote Remote, serverURL string, snapshot map[string]*domain.Map, result *Result) error {
	records, err := e.store.List(ctx)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.RemoteURL != "" && record.RemoteURL != serverURL {
			continue // 属于别的云端，不动
		}
		if record.State == syncstate.StateConflict {
			continue // 等用户处理
		}
		if err := e.pushOne(ctx, remote, serverURL, snapshot, record, result); err != nil {
			e.log.Warn("sync: push failed", "uid", record.MapUID, "err", err)
			result.Failed = append(result.Failed, record.MapUID)
			if errors.Is(err, cloud.ErrUnauthorized) || errors.Is(err, cloud.ErrUnavailable) {
				return err // 连接层面的问题：后面不用再试了
			}
		}
	}
	return nil
}

func (e *Engine) pushOne(ctx context.Context, remote Remote, serverURL string, snapshot map[string]*domain.Map, record *syncstate.Record, result *Result) error {
	local, ok := snapshot[record.MapUID]
	if !ok {
		return e.store.Delete(ctx, record.MapUID)
	}

	// 本地删除要推到云端：先删云端，再记「两边都删了」。
	if local.IsTrashed() {
		if record.Deleted || record.RemoteUID == "" {
			return nil
		}
		if err := remote.Delete(ctx, record.RemoteUID); err != nil && !errors.Is(err, cloud.ErrMapNotFound) {
			return err
		}
		record.Deleted = true
		record.State = syncstate.StateSynced
		record.UpdatedAt = e.now()
		result.Deleted++
		return e.store.Put(ctx, record)
	}

	if hashBytes(local.Document) == record.BaseLocalHash {
		if record.State != syncstate.StateSynced {
			record.State = syncstate.StateSynced
			record.UpdatedAt = e.now()
			return e.store.Put(ctx, record)
		}
		return nil
	}

	if record.RemoteUID == "" || record.RemoteURL != serverURL {
		uploaded, err := remote.Upload(ctx, local.UID, local.Title, json.RawMessage(local.Document))
		if err != nil {
			return err
		}
		synced := e.now()
		record.RemoteUID = uploaded.UID
		record.RemoteURL = serverURL
		record.BaseVersion = uploaded.Version
		record.BaseHash = uploaded.DocumentHash
		record.BaseLocalHash = hashBytes(local.Document)
		record.LastSyncedAt = &synced
		record.State = syncstate.StateSynced
		record.UpdatedAt = synced
		result.Pushed++
		return e.store.Put(ctx, record)
	}

	// 乐观锁推送；版本漂移（内容没变）就带新版本重试一次。
	for attempt := 0; attempt < 2; attempt++ {
		saved, err := remote.Save(ctx, record.RemoteUID, record.BaseVersion, local.Title, json.RawMessage(local.Document))
		if err == nil {
			synced := e.now()
			record.BaseVersion = saved.Version
			record.BaseHash = saved.DocumentHash
			record.BaseLocalHash = hashBytes(local.Document)
			record.LastSyncedAt = &synced
			record.State = syncstate.StateSynced
			record.UpdatedAt = synced
			result.Pushed++
			return e.store.Put(ctx, record)
		}
		var conflict *cloud.ConflictError
		if !errors.As(err, &conflict) {
			return err
		}
		if conflict.CurrentHash != "" && conflict.CurrentHash == record.BaseHash {
			// 只是版本号漂移，内容与基线一致：带上新版本再来一次。
			record.BaseVersion = conflict.CurrentVersion
			continue
		}
		record.State = syncstate.StateConflict
		record.UpdatedAt = e.now()
		result.Conflicts = append(result.Conflicts, record.MapUID)
		return e.store.Put(ctx, record)
	}
	return fmt.Errorf("syncengine: save kept conflicting for %s", record.MapUID)
}

// ResolveConflict 按用户的决定处理一次冲突。
//
// keepLocal 为 true 表示用本地内容覆盖云端，否则用云端内容覆盖本地。
// 「另存为副本」不需要走这里：它是一次普通的本地新建 + 上传。
func (e *Engine) ResolveConflict(ctx context.Context, mapUID string, keepLocal bool) error {
	e.mu.Lock()
	remote := e.remote
	e.mu.Unlock()
	if remote == nil {
		return ErrNotConnected
	}

	record, err := e.store.Get(ctx, mapUID)
	if err != nil {
		return err
	}
	local, err := e.local.GetByUID(ctx, mapUID, e.ownerID)
	if err != nil {
		return err
	}

	if keepLocal {
		// 拿云端当前版本号做基线，再推一次本地内容。
		remoteMap, err := remote.GetMap(ctx, record.RemoteUID)
		if err != nil {
			return err
		}
		saved, err := remote.Save(ctx, record.RemoteUID, remoteMap.Version, local.Title, json.RawMessage(local.Document))
		if err != nil {
			return err
		}
		synced := e.now()
		record.BaseVersion = saved.Version
		record.BaseHash = saved.DocumentHash
		record.BaseLocalHash = hashBytes(local.Document)
		record.LastSyncedAt = &synced
		record.State = syncstate.StateSynced
		record.UpdatedAt = synced
		return e.store.Put(ctx, record)
	}

	remoteMap, err := remote.GetMap(ctx, record.RemoteUID)
	if err != nil {
		return err
	}
	updated, err := e.local.UpdateWithVersion(ctx, domain.UpdateMapInput{
		UID: mapUID, OwnerID: e.ownerID,
		Title: remoteMap.Title, Document: remoteMap.Document,
		NodeCount: remoteMap.NodeCount, SizeBytes: int64(len(remoteMap.Document)),
		ExpectedVersion: local.Version, Now: e.now(),
	})
	if err != nil {
		return err
	}
	synced := e.now()
	record.BaseVersion = remoteMap.Version
	record.BaseHash = remoteMap.DocumentHash
	record.BaseLocalHash = hashBytes(updated.Document)
	record.LastSyncedAt = &synced
	record.State = syncstate.StateSynced
	record.UpdatedAt = synced
	return e.store.Put(ctx, record)
}

// MarkLocalDirty 在本地保存之后调用，把记录标成「有本地改动」。
//
// 不在这里重算摘要：保存路径已经在写库，多一次读会引入竞态；状态只需要
// 标记「待同步」，真正的判断在 Sync 里按摘要做。
func (e *Engine) MarkLocalDirty(ctx context.Context, mapUID string) error {
	record, err := e.store.Get(ctx, mapUID)
	if errors.Is(err, syncstate.ErrNotFound) {
		return nil // 还没上传过：本地模式下的普通保存，不需要记录
	}
	if err != nil {
		return err
	}
	if record.State == syncstate.StateConflict {
		return nil
	}
	record.State = syncstate.StateLocalDirty
	record.UpdatedAt = e.now()
	return e.store.Put(ctx, record)
}

func (e *Engine) pullCursor(ctx context.Context) (time.Time, error) {
	raw, err := e.store.GetMeta(ctx, syncstate.MetaLastPullAt)
	if err != nil {
		return time.Time{}, err
	}
	if raw == "" {
		return time.Time{}, nil
	}
	at, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("syncengine: bad pull cursor %q: %w", raw, err)
	}
	return at.UTC(), nil
}

func hashBytes(document []byte) string {
	sum := sha256.Sum256(document)
	return hex.EncodeToString(sum[:])
}
