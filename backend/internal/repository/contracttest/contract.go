// Package contracttest contains reusable behavioral tests for every dialect's
// domain repository implementations. Driver-specific Test files supply real
// migrated databases and call Run.
package contracttest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

// Repos 是一次契约测试需要的全部仓储实现。
//
// 用结构体而不是六个位置参数：仓储会随里程碑增加，位置参数每次都要改所有
// 调用点，而且调用点漏传一个时编译错误只提示「参数不够」。
type Repos struct {
	Users    domain.UserRepo
	Maps     domain.MapRepo
	Tokens   domain.RefreshTokenRepo
	Settings domain.SettingsRepo
	Audit    domain.AuditRepo
	Tx       domain.TxManager
}

func Run(t *testing.T, r Repos) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	uid := ulid.Make().String()
	users, maps, tx := r.Users, r.Maps, r.Tx

	t.Run("user CRUD, lookup, filtering, and duplicate mapping", func(t *testing.T) {
		user, err := users.Create(ctx, domain.CreateUserInput{
			UID: uid, Username: "wmind_" + uid, Email: uid + "@example.test",
			PasswordHash: "hash-v1", Nickname: "Initial", Role: domain.RoleAdmin,
			Status: domain.UserStatusActive, Now: now.Add(987654 * time.Nanosecond),
		})
		if err != nil {
			t.Fatalf("Create user: %v", err)
		}
		if user.ID <= 0 || user.UID != uid || !user.CreatedAt.Equal(now.Truncate(time.Millisecond)) || user.LastLoginAt != nil {
			t.Fatalf("created user mismatch: %#v", user)
		}

		assertUser := func(name string, lookup func() (*domain.User, error)) {
			t.Helper()
			got, err := lookup()
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if got.UID != uid || got.ID != user.ID {
				t.Fatalf("%s returned another user: %#v", name, got)
			}
		}
		assertUser("GetByID", func() (*domain.User, error) { return users.GetByID(ctx, user.ID) })
		assertUser("GetByUID", func() (*domain.User, error) { return users.GetByUID(ctx, uid) })
		assertUser("GetByEmail", func() (*domain.User, error) { return users.GetByEmail(ctx, uid+"@EXAMPLE.TEST") })
		assertUser("GetByUsername", func() (*domain.User, error) { return users.GetByUsername(ctx, "WMIND_"+uid) })

		listInput := domain.ListUsersInput{Keyword: uid[8:20], Role: domain.RoleAdmin, Status: domain.UserStatusActive, Page: domain.Page{Limit: 5}}
		listed, err := users.List(ctx, listInput)
		if err != nil || len(listed) != 1 || listed[0].UID != uid {
			t.Fatalf("List filtered users = %#v, %v", listed, err)
		}
		count, err := users.CountFiltered(ctx, listInput)
		if err != nil || count != 1 {
			t.Fatalf("CountFiltered = %d, %v; want 1", count, err)
		}
		if total, err := users.Count(ctx); err != nil || total < 1 {
			t.Fatalf("Count = %d, %v; want at least 1", total, err)
		}
		if admins, err := users.CountActiveAdmins(ctx); err != nil || admins < 1 {
			t.Fatalf("CountActiveAdmins = %d, %v; want at least 1", admins, err)
		}

		updated, err := users.UpdateProfile(ctx, domain.UpdateProfileInput{
			UID: uid, Nickname: "Updated", AvatarURL: "/avatar.png", Now: now.Add(time.Minute),
		})
		if err != nil || updated.Nickname != "Updated" || updated.AvatarURL != "/avatar.png" {
			t.Fatalf("UpdateProfile = %#v, %v", updated, err)
		}
		if err := users.UpdatePassword(ctx, user.ID, "hash-v2", now.Add(2*time.Minute)); err != nil {
			t.Fatalf("UpdatePassword: %v", err)
		}
		if err := users.TouchLastLogin(ctx, user.ID, now.Add(3*time.Minute)); err != nil {
			t.Fatalf("TouchLastLogin: %v", err)
		}
		updated, err = users.UpdateRole(ctx, uid, domain.RoleUser, now.Add(4*time.Minute))
		if err != nil || updated.Role != domain.RoleUser {
			t.Fatalf("UpdateRole = %#v, %v", updated, err)
		}
		updated, err = users.UpdateStatus(ctx, uid, domain.UserStatusDisabled, now.Add(5*time.Minute))
		if err != nil || updated.Status != domain.UserStatusDisabled {
			t.Fatalf("UpdateStatus = %#v, %v", updated, err)
		}
		updated, err = users.UpdateStatus(ctx, uid, domain.UserStatusActive, now.Add(6*time.Minute))
		if err != nil || updated.Status != domain.UserStatusActive {
			t.Fatalf("reactivate user = %#v, %v", updated, err)
		}

		_, err = users.Create(ctx, domain.CreateUserInput{
			UID: ulid.Make().String(), Username: "duplicate_" + uid,
			Email: uid + "@example.test", PasswordHash: "hash", Role: domain.RoleUser,
			Status: domain.UserStatusActive, Now: now,
		})
		if !errors.Is(err, domain.ErrDuplicate) {
			t.Fatalf("duplicate email error = %v; want domain.ErrDuplicate", err)
		}
	})

	t.Run("map CRUD, owner isolation, optimistic lock, and recycle bin", func(t *testing.T) {
		owner, err := users.GetByUID(ctx, uid)
		if err != nil {
			t.Fatalf("get owner: %v", err)
		}
		mapUID := ulid.Make().String()
		doc := []byte(`{"formatVersion":1,"sheets":[]}`)
		created, err := maps.Create(ctx, domain.CreateMapInput{
			UID: mapUID, OwnerID: owner.ID, Title: "Quarterly Plan", Document: doc,
			NodeCount: 7, SizeBytes: int64(len(doc)), Now: now,
		})
		if err != nil {
			t.Fatalf("Create map: %v", err)
		}
		if created.Version != 1 || string(created.Document) != string(doc) || created.SizeBytes != int64(len(doc)) {
			t.Fatalf("created map mismatch: %#v", created)
		}
		if _, err := maps.GetByUID(ctx, mapUID, owner.ID+999); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner read = %v; want domain.ErrNotFound", err)
		}
		if _, err := maps.GetForUpdate(ctx, mapUID, owner.ID); err == nil {
			t.Fatal("GetForUpdate outside transaction unexpectedly succeeded")
		}
		if count, err := maps.CountByOwner(ctx, owner.ID); err != nil || count != 1 {
			t.Fatalf("CountByOwner = %d, %v; want 1", count, err)
		}
		listed, err := maps.ListByOwner(ctx, owner.ID, domain.Page{Limit: 5})
		if err != nil || len(listed) != 1 || listed[0].UID != mapUID {
			t.Fatalf("ListByOwner = %#v, %v", listed, err)
		}
		searched, err := maps.SearchByTitle(ctx, owner.ID, "%plan%", domain.Page{Limit: 5})
		if err != nil || len(searched) != 1 || searched[0].UID != mapUID {
			t.Fatalf("SearchByTitle = %#v, %v", searched, err)
		}
		if count, err := maps.CountByTitle(ctx, owner.ID, "%plan%"); err != nil || count != 1 {
			t.Fatalf("CountByTitle = %d, %v; want 1", count, err)
		}

		updated, err := maps.UpdateWithVersion(ctx, domain.UpdateMapInput{
			UID: mapUID, OwnerID: owner.ID, Title: "Quarterly Plan v2", Document: doc,
			ThumbnailURL: "/thumb.svg", NodeCount: 8, SizeBytes: int64(len(doc)),
			ExpectedVersion: 1, Now: now.Add(time.Minute),
		})
		if err != nil || updated.Version != 2 || updated.Title != "Quarterly Plan v2" {
			t.Fatalf("UpdateWithVersion = %#v, %v", updated, err)
		}
		_, err = maps.UpdateWithVersion(ctx, domain.UpdateMapInput{
			UID: mapUID, OwnerID: owner.ID, Title: "stale", Document: doc,
			ExpectedVersion: 1, Now: now.Add(2 * time.Minute),
		})
		if !errors.Is(err, domain.ErrVersionConflict) {
			t.Fatalf("stale update error = %v; want domain.ErrVersionConflict", err)
		}
		if _, err := maps.UpdateMeta(ctx, mapUID, owner.ID, "Renamed", now.Add(3*time.Minute)); err != nil {
			t.Fatalf("UpdateMeta: %v", err)
		}
		if err := maps.UpdateThumbnail(ctx, mapUID, owner.ID, "/thumb-2.svg", now.Add(4*time.Minute)); err != nil {
			t.Fatalf("UpdateThumbnail: %v", err)
		}
		if err := users.IncrementMapCount(ctx, owner.ID, 1, now.Add(4*time.Minute)); err != nil {
			t.Fatalf("IncrementMapCount: %v", err)
		}
		owner, err = users.GetByUID(ctx, uid)
		if err != nil || owner.MapCount != 1 {
			t.Fatalf("MapCount = %#v, %v; want 1", owner, err)
		}

		if err := maps.SoftDelete(ctx, mapUID, owner.ID, now.Add(5*time.Minute)); err != nil {
			t.Fatalf("SoftDelete map: %v", err)
		}
		if _, err := maps.GetByUID(ctx, mapUID, owner.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("read soft-deleted map = %v; want not found", err)
		}
		if count, err := maps.CountTrashed(ctx, owner.ID); err != nil || count != 1 {
			t.Fatalf("CountTrashed = %d, %v; want 1", count, err)
		}
		trashed, err := maps.ListTrashed(ctx, owner.ID, domain.Page{Limit: 5})
		if err != nil || len(trashed) != 1 || trashed[0].UID != mapUID {
			t.Fatalf("ListTrashed = %#v, %v", trashed, err)
		}
		all, err := maps.ListAllIncludingDeleted(ctx, owner.ID)
		if err != nil || len(all) != 1 || !all[0].IsTrashed() {
			t.Fatalf("ListAllIncludingDeleted = %#v, %v", all, err)
		}
		restored, err := maps.Restore(ctx, mapUID, owner.ID, now.Add(6*time.Minute))
		if err != nil || restored.IsTrashed() {
			t.Fatalf("Restore = %#v, %v", restored, err)
		}
		if err := maps.HardDelete(ctx, mapUID, owner.ID); err != nil {
			t.Fatalf("HardDelete: %v", err)
		}
		if _, err := maps.GetByUID(ctx, mapUID, owner.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("read hard-deleted map = %v; want not found", err)
		}
	})

	t.Run("transaction rollback and GetForUpdate pinning", func(t *testing.T) {
		owner, err := users.GetByUID(ctx, uid)
		if err != nil {
			t.Fatalf("get owner: %v", err)
		}
		rolledBackUID := ulid.Make().String()
		abort := errors.New("abort test transaction")
		err = tx.WithTx(ctx, func(txCtx context.Context) error {
			if _, err := maps.Create(txCtx, domain.CreateMapInput{
				UID: rolledBackUID, OwnerID: owner.ID, Title: "rollback", Document: []byte(`{"ok":true}`),
				Now: now,
			}); err != nil {
				return err
			}
			if _, err := maps.GetForUpdate(txCtx, rolledBackUID, owner.ID); err != nil {
				return fmt.Errorf("GetForUpdate in transaction: %w", err)
			}
			return abort
		})
		if !errors.Is(err, abort) {
			t.Fatalf("rollback transaction error = %v; want abort marker", err)
		}
		if _, err := maps.GetByUID(ctx, rolledBackUID, owner.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("rolled-back map lookup = %v; want not found", err)
		}

		committedUID := ulid.Make().String()
		err = tx.WithTx(ctx, func(txCtx context.Context) error {
			created, err := maps.Create(txCtx, domain.CreateMapInput{
				UID: committedUID, OwnerID: owner.ID, Title: "commit", Document: []byte(`{"ok":true}`), Now: now,
			})
			if err != nil {
				return err
			}
			locked, err := maps.GetForUpdate(txCtx, committedUID, owner.ID)
			if err != nil || locked.ID != created.ID {
				return fmt.Errorf("GetForUpdate returned %#v, %w", locked, err)
			}
			_, err = maps.UpdateWithVersion(txCtx, domain.UpdateMapInput{
				UID: committedUID, OwnerID: owner.ID, Title: "committed", Document: []byte(`{"ok":true}`),
				ExpectedVersion: 1, Now: now.Add(time.Minute),
			})
			return err
		})
		if err != nil {
			t.Fatalf("commit transaction: %v", err)
		}
		committed, err := maps.GetByUID(ctx, committedUID, owner.ID)
		if err != nil || committed.Title != "committed" || committed.Version != 2 {
			t.Fatalf("committed map = %#v, %v", committed, err)
		}
		if err := maps.HardDelete(ctx, committedUID, owner.ID); err != nil {
			t.Fatalf("cleanup committed map: %v", err)
		}
	})

	t.Run("missing-row semantics and soft delete", func(t *testing.T) {
		if _, err := maps.GetByUID(ctx, ulid.Make().String(), 1); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("missing map error = %v; want ErrNotFound", err)
		}
		if err := maps.UpdateThumbnail(ctx, ulid.Make().String(), 1, "", now); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("missing map update error = %v; want ErrNotFound", err)
		}
		if err := users.SoftDelete(ctx, uid, now.Add(10*time.Minute)); err != nil {
			t.Fatalf("SoftDelete user: %v", err)
		}
		if _, err := users.GetByUID(ctx, uid); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("read soft-deleted user = %v; want not found", err)
		}
		if err := users.UpdatePassword(ctx, 999999999, "hash", now); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("missing user update error = %v; want ErrNotFound", err)
		}
	})

	t.Run("refresh token lifecycle", func(t *testing.T) {
		owner := mustCreateUser(t, ctx, users, now)

		create := func(hash string, expiresAt time.Time) *domain.RefreshToken {
			t.Helper()
			v, err := r.Tokens.Create(ctx, domain.CreateRefreshTokenInput{
				UserID: owner.ID, TokenHash: hash, Platform: "web", Device: "contract-test",
				ExpiresAt: expiresAt, Now: now,
			})
			if err != nil {
				t.Fatalf("create refresh token %s: %v", hash, err)
			}
			return v
		}

		hash := "hash-" + ulid.Make().String()
		create(hash, now.Add(time.Hour))

		got, err := r.Tokens.GetByHash(ctx, hash)
		if err != nil || got.UserID != owner.ID || !got.Usable(now) || got.Revoked() {
			t.Fatalf("GetByHash = %#v, %v; want usable token", got, err)
		}

		// Revocation is idempotent and reports whether it actually changed a row.
		if revoked, err := r.Tokens.Revoke(ctx, hash, now.Add(time.Minute)); err != nil || !revoked {
			t.Fatalf("first Revoke = %v, %v; want true", revoked, err)
		}
		if revoked, err := r.Tokens.Revoke(ctx, hash, now.Add(time.Minute)); err != nil || revoked {
			t.Fatalf("second Revoke = %v, %v; want false", revoked, err)
		}
		after, err := r.Tokens.GetByHash(ctx, hash)
		if err != nil || after.RevokedAt == nil || after.Usable(now.Add(2*time.Minute)) {
			t.Fatalf("revoked token = %#v, %v; want revoked_at set", after, err)
		}

		// Expiry is evaluated by the caller-supplied clock, not by the row.
		expiredHash := "hash-" + ulid.Make().String()
		create(expiredHash, now.Add(-time.Minute))
		expired, err := r.Tokens.GetByHash(ctx, expiredHash)
		if err != nil || !expired.Expired(now) || expired.Usable(now) {
			t.Fatalf("expired token = %#v, %v; want expired", expired, err)
		}

		keepHash := "hash-" + ulid.Make().String()
		dropHash := "hash-" + ulid.Make().String()
		create(keepHash, now.Add(time.Hour))
		create(dropHash, now.Add(time.Hour))

		// RevokeAllExcept must spare exactly the token that made the request.
		revokedCount, err := r.Tokens.RevokeAllExcept(ctx, owner.ID, keepHash, now.Add(2*time.Minute))
		if err != nil || revokedCount != 2 {
			t.Fatalf("RevokeAllExcept = %d, %v; want 2 (drop + expired)", revokedCount, err)
		}
		kept, err := r.Tokens.GetByHash(ctx, keepHash)
		if err != nil || !kept.Usable(now.Add(3*time.Minute)) {
			t.Fatalf("kept token = %#v, %v; want still usable", kept, err)
		}

		if revokedCount, err := r.Tokens.RevokeAllForUser(ctx, owner.ID, now.Add(4*time.Minute)); err != nil || revokedCount != 1 {
			t.Fatalf("RevokeAllForUser = %d, %v; want 1", revokedCount, err)
		}

		// Only the expired row qualifies for cleanup; the rest expire in an hour.
		if deleted, err := r.Tokens.DeleteExpired(ctx, now); err != nil || deleted != 1 {
			t.Fatalf("DeleteExpired = %d, %v; want 1", deleted, err)
		}
	})

	t.Run("settings upsert, reload, and JSON round-trip", func(t *testing.T) {
		actor := mustCreateUser(t, ctx, users, now)
		key := "site.contract." + ulid.Make().String()

		if err := r.Settings.Upsert(ctx, key, `{"enabled":true}`, nil, now); err != nil {
			t.Fatalf("insert setting: %v", err)
		}
		if err := r.Settings.Upsert(ctx, key, `{"enabled":false,"limit":3}`, &actor.ID, now.Add(time.Minute)); err != nil {
			t.Fatalf("update setting: %v", err)
		}

		all, err := r.Settings.List(ctx)
		if err != nil {
			t.Fatalf("list settings: %v", err)
		}
		var found *domain.Setting
		for _, s := range all {
			if s.Key == key {
				if found != nil {
					t.Fatalf("duplicate rows for key %q", key)
				}
				found = s
			}
		}
		if found == nil {
			t.Fatalf("setting %q missing after upsert", key)
		}
		// Compare decoded JSON, not raw text: PostgreSQL stores JSONB, which
		// reorders keys and drops whitespace, so byte equality would pass on
		// SQLite and fail on PostgreSQL for the same logical value.
		if !sameJSON(t, found.Value, `{"enabled":false,"limit":3}`) {
			t.Fatalf("setting value = %q; want the updated document", found.Value)
		}
		if found.UpdatedBy == nil || *found.UpdatedBy != actor.ID {
			t.Fatalf("setting updatedBy = %v; want %d", found.UpdatedBy, actor.ID)
		}
		if !found.UpdatedAt.Equal(now.Add(time.Minute)) {
			t.Fatalf("setting updatedAt = %v; want %v", found.UpdatedAt, now.Add(time.Minute))
		}
	})

	t.Run("audit log append and read", func(t *testing.T) {
		actor := mustCreateUser(t, ctx, users, now)
		before, err := r.Audit.Count(ctx)
		if err != nil {
			t.Fatalf("count audit logs: %v", err)
		}

		targetID := "target-" + ulid.Make().String()
		if err := r.Audit.Create(ctx, domain.CreateAuditLogInput{
			ActorID: &actor.ID, Action: domain.AuditUserDisable, TargetType: "user",
			TargetID: targetID, Detail: `{"reason":"contract"}`, IP: "203.0.113.7", Now: now,
		}); err != nil {
			t.Fatalf("create audit log: %v", err)
		}

		// A malformed address must not lose the record: the action matters more
		// than the source IP, so PostgreSQL drops the address instead of failing.
		badIPTarget := "target-" + ulid.Make().String()
		if err := r.Audit.Create(ctx, domain.CreateAuditLogInput{
			ActorID: &actor.ID, Action: domain.AuditUserDisable, TargetType: "user",
			TargetID: badIPTarget, Detail: `{}`, IP: "not-an-ip", Now: now,
		}); err != nil {
			t.Fatalf("create audit log with malformed IP: %v", err)
		}

		after, err := r.Audit.Count(ctx)
		if err != nil || after != before+2 {
			t.Fatalf("audit count = %d, %v; want %d", after, err, before+2)
		}

		logs, err := r.Audit.List(ctx, domain.Page{Limit: 50})
		if err != nil {
			t.Fatalf("list audit logs: %v", err)
		}
		seen := map[string]*domain.AuditLog{}
		for _, entry := range logs {
			seen[entry.TargetID] = entry
		}
		entry := seen[targetID]
		if entry == nil || entry.IP != "203.0.113.7" || entry.Action != domain.AuditUserDisable {
			t.Fatalf("audit entry = %#v; want IP 203.0.113.7 and action %q", entry, domain.AuditUserDisable)
		}
		if entry.ActorID == nil || *entry.ActorID != actor.ID || !entry.CreatedAt.Equal(now) {
			t.Fatalf("audit entry actor/time = %#v; want %d at %v", entry, actor.ID, now)
		}
		if !sameJSON(t, entry.Detail, `{"reason":"contract"}`) {
			t.Fatalf("audit detail = %q", entry.Detail)
		}
		if dropped := seen[badIPTarget]; dropped == nil || dropped.IP != "" {
			t.Fatalf("audit entry with malformed IP = %#v; want empty IP", dropped)
		}
	})
}

// mustCreateUser 造一个独立用户，避免新子测试依赖前一个子测试的副作用。
func mustCreateUser(t *testing.T, ctx context.Context, users domain.UserRepo, now time.Time) *domain.User {
	t.Helper()
	uid := ulid.Make().String()
	user, err := users.Create(ctx, domain.CreateUserInput{
		UID: uid, Username: "wmind_" + uid, Email: uid + "@example.test",
		PasswordHash: "hash-contract", Nickname: "Contract", Role: domain.RoleUser,
		Status: domain.UserStatusActive, Now: now,
	})
	if err != nil {
		t.Fatalf("create contract user: %v", err)
	}
	return user
}

// sameJSON 比较两个 JSON 文档的语义相等，忽略键序与空白。
func sameJSON(t *testing.T, got, want string) bool {
	t.Helper()
	var gotValue, wantValue any
	if err := json.Unmarshal([]byte(got), &gotValue); err != nil {
		t.Fatalf("decode %q: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatalf("decode %q: %v", want, err)
	}
	return reflect.DeepEqual(gotValue, wantValue)
}
