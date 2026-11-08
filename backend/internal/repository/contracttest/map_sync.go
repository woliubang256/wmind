package contracttest

import (
	"errors"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

// MapSync 覆盖客户端增量同步用到的两个仓储能力：
//
//   - ListChangedSince：返回 since 之后有变化的导图，**包含回收站里的**；
//     软删除与恢复都算变更（因为都会更新 updated_at）。
//   - GetIncludingDeleted：能读到回收站里的导图，供上传幂等判断使用。
//
// 两种方言必须给出相同结果，尤其是时间比较——SQLite 存字符串、PostgreSQL
// 存 timestamptz，边界（同一毫秒）很容易一边包含一边不包含。
func MapSync(t *testing.T, users domain.UserRepo, maps domain.MapRepo) {
	t.Helper()
	ctx := t.Context()
	prefix := ulid.Make().String()
	base := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)

	owner, err := users.Create(ctx, domain.CreateUserInput{
		UID: prefix, Username: prefix, Email: prefix + "@example.test",
		PasswordHash: "hash", Role: domain.RoleUser, Status: domain.UserStatusActive, Now: base,
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := users.Create(ctx, domain.CreateUserInput{
		UID: prefix + "b", Username: prefix + "b", Email: prefix + "b@example.test",
		PasswordHash: "hash", Role: domain.RoleUser, Status: domain.UserStatusActive, Now: base,
	})
	if err != nil {
		t.Fatal(err)
	}

	create := func(uid string, at time.Time, who int64) *domain.Map {
		m, err := maps.Create(ctx, domain.CreateMapInput{
			UID: uid, OwnerID: who, Title: "sync", Document: []byte(`{"title":"sync"}`),
			NodeCount: 1, SizeBytes: 16, Now: at,
		})
		if err != nil {
			t.Fatal(err)
		}
		return m
	}

	old := create(prefix+"old", base.Add(-2*time.Hour), owner.ID)
	fresh := create(prefix+"fresh", base.Add(-30*time.Minute), owner.ID)
	trashed := create(prefix+"trash", base.Add(-30*time.Minute), owner.ID)
	foreign := create(prefix+"foreign", base, other.ID)

	// 软删除本身就是一次变更：删除时间晚于游标，必须出现在增量结果里。
	deletedAt := base.Add(10 * time.Minute)
	if err := maps.SoftDelete(ctx, trashed.UID, owner.ID, deletedAt); err != nil {
		t.Fatal(err)
	}

	changed, err := maps.ListChangedSince(ctx, owner.ID, base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]*domain.Map, len(changed))
	for _, m := range changed {
		seen[m.UID] = m
	}
	if _, ok := seen[old.UID]; ok {
		t.Fatal("游标之前创建的导图不应出现在增量结果里")
	}
	if _, ok := seen[fresh.UID]; !ok {
		t.Fatal("游标之后修改的导图必须出现")
	}
	got, ok := seen[trashed.UID]
	if !ok {
		t.Fatal("回收站里的导图也必须出现在增量结果里（删除是一次变更）")
	}
	if !got.IsTrashed() {
		t.Fatal("增量结果里的已删除导图必须带删除标记")
	}
	if _, ok := seen[foreign.UID]; ok {
		t.Fatal("不能返回其他用户的导图")
	}
	// 顺序必须稳定且按更新时间升序：客户端拿最后一条的 updatedAt 当游标。
	for i := 1; i < len(changed); i++ {
		if changed[i].UpdatedAt.Before(changed[i-1].UpdatedAt) {
			t.Fatalf("增量结果必须按 updatedAt 升序: %d", i)
		}
	}

	// 游标取「最后一条之后」必须拿到空集，否则客户端会无限重拉同一批。
	if changed != nil {
		last := changed[len(changed)-1].UpdatedAt
		rest, err := maps.ListChangedSince(ctx, owner.ID, last.Add(time.Millisecond))
		if err != nil {
			t.Fatal(err)
		}
		if len(rest) != 0 {
			t.Fatalf("游标之后的增量应为空，实际 %d 条", len(rest))
		}
	}

	// GetIncludingDeleted：回收站里的读得到，别的用户读不到。
	found, err := maps.GetIncludingDeleted(ctx, trashed.UID, owner.ID)
	if err != nil {
		t.Fatalf("应当能读到回收站里的导图: %v", err)
	}
	if found.UID != trashed.UID || !found.IsTrashed() {
		t.Fatalf("读到的导图不符合预期: %+v", found)
	}
	if _, err := maps.GetIncludingDeleted(ctx, trashed.UID, other.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("跨用户读取应当返回 ErrNotFound，实际 %v", err)
	}
}
