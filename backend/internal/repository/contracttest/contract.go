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
	Users     domain.UserRepo
	Maps      domain.MapRepo
	Tokens    domain.RefreshTokenRepo
	Settings  domain.SettingsRepo
	Audit     domain.AuditRepo
	Shares    domain.ShareRepo
	Templates domain.TemplateRepo
	Themes    domain.ThemeRepo
	Tx        domain.TxManager
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
		listed, err := maps.ListByOwner(ctx, owner.ID, domain.MapSortUpdated, domain.Page{Limit: 5})
		if err != nil || len(listed) != 1 || listed[0].UID != mapUID {
			t.Fatalf("ListByOwner = %#v, %v", listed, err)
		}
		searched, err := maps.SearchByTitle(ctx, owner.ID, "%plan%", domain.MapSortUpdated, domain.Page{Limit: 5})
		if err != nil || len(searched) != 1 || searched[0].UID != mapUID {
			t.Fatalf("SearchByTitle = %#v, %v", searched, err)
		}
		if count, err := maps.CountByTitle(ctx, owner.ID, "%plan%"); err != nil || count != 1 {
			t.Fatalf("CountByTitle = %d, %v; want 1", count, err)
		}

		updated, err := maps.UpdateWithVersion(ctx, domain.UpdateMapInput{
			UID: mapUID, OwnerID: owner.ID, Title: "Quarterly Plan v2", Document: doc,
			NodeCount: 8, SizeBytes: int64(len(doc)),
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

	t.Run("map list sorting and thumbnail survives a save", func(t *testing.T) {
		// A dedicated owner: the assertions below count on knowing exactly which
		// three maps exist, and reusing the owner above would couple this test to
		// every future addition in that subtest.
		sortUID := ulid.Make().String()
		owner, err := users.Create(ctx, domain.CreateUserInput{
			UID: sortUID, Username: "sort_" + sortUID, Email: sortUID + "@example.test",
			PasswordHash: "hash", Role: domain.RoleUser,
			Status: domain.UserStatusActive, Now: now,
		})
		if err != nil {
			t.Fatalf("Create sort owner: %v", err)
		}

		// The three orders are deliberately all different, so a bug that ignores
		// the sort argument cannot pass by accident:
		//   created  -> C, B, A     (newest first; A was created first)
		//   updated  -> A, C, B     (A is touched again at +9m)
		//   title    -> B, A, C     (a-first < b-middle < c-last)
		doc := []byte(`{"formatVersion":1,"sheets":[]}`)
		mk := func(title string, at time.Time) *domain.Map {
			t.Helper()
			created, err := maps.Create(ctx, domain.CreateMapInput{
				UID: ulid.Make().String(), OwnerID: owner.ID, Title: title, Document: doc,
				NodeCount: 1, SizeBytes: int64(len(doc)), Now: at,
			})
			if err != nil {
				t.Fatalf("Create %q: %v", title, err)
			}
			return created
		}
		a := mk("b-middle", now.Add(time.Minute))
		mk("a-first", now.Add(2*time.Minute))
		mk("c-last", now.Add(3*time.Minute))
		if _, err := maps.UpdateMeta(ctx, a.UID, owner.ID, a.Title, now.Add(9*time.Minute)); err != nil {
			t.Fatalf("UpdateMeta: %v", err)
		}

		order := func(list []*domain.Map) []string {
			out := make([]string, 0, len(list))
			for _, m := range list {
				out = append(out, m.Title)
			}
			return out
		}
		expectOrder := func(name string, got []string, want ...string) {
			t.Helper()
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s = %v; want %v", name, got, want)
			}
		}

		page := domain.Page{Limit: 10}
		for _, tc := range []struct {
			sort domain.MapSort
			want []string
		}{
			{domain.MapSortUpdated, []string{"b-middle", "c-last", "a-first"}},
			{domain.MapSortCreated, []string{"c-last", "a-first", "b-middle"}},
			{domain.MapSortTitle, []string{"a-first", "b-middle", "c-last"}},
		} {
			listed, err := maps.ListByOwner(ctx, owner.ID, tc.sort, page)
			if err != nil {
				t.Fatalf("ListByOwner(%s): %v", tc.sort, err)
			}
			expectOrder("ListByOwner("+string(tc.sort)+")", order(listed), tc.want...)

			// Search must honour the same sort. Pattern "-" matches all three
			// titles, so the ordering is directly comparable with the list above.
			found, err := maps.SearchByTitle(ctx, owner.ID, "%-%", tc.sort, page)
			if err != nil {
				t.Fatalf("SearchByTitle(%s): %v", tc.sort, err)
			}
			expectOrder("SearchByTitle("+string(tc.sort)+")", order(found), tc.want...)
		}

		// Regression: saving used to write thumbnail_url from the save input, and
		// autosave has no thumbnail to send -- so every save erased it.
		if err := maps.UpdateThumbnail(ctx, a.UID, owner.ID, "/uploads/thumb.png", now.Add(10*time.Minute)); err != nil {
			t.Fatalf("UpdateThumbnail: %v", err)
		}
		if _, err := maps.UpdateWithVersion(ctx, domain.UpdateMapInput{
			UID: a.UID, OwnerID: owner.ID, Title: "b-middle renamed", Document: doc,
			NodeCount: 2, SizeBytes: int64(len(doc)), ExpectedVersion: a.Version,
			Now: now.Add(11 * time.Minute),
		}); err != nil {
			t.Fatalf("UpdateWithVersion: %v", err)
		}
		reloaded, err := maps.GetByUID(ctx, a.UID, owner.ID)
		if err != nil {
			t.Fatalf("GetByUID after save: %v", err)
		}
		if reloaded.ThumbnailURL != "/uploads/thumb.png" {
			t.Fatalf("thumbnail after save = %q; want it preserved", reloaded.ThumbnailURL)
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

	t.Run("email update and case-insensitive uniqueness", func(t *testing.T) {
		user := mustCreateUser(t, ctx, users, now)

		updated, err := users.UpdateEmail(ctx, user.UID, "renamed-"+user.UID+"@example.test", now.Add(time.Minute))
		if err != nil || updated.Email != "renamed-"+user.UID+"@example.test" {
			t.Fatalf("UpdateEmail = %#v, %v", updated, err)
		}
		if !updated.UpdatedAt.Equal(now.Add(time.Minute)) {
			t.Fatalf("updatedAt = %v; want %v", updated.UpdatedAt, now.Add(time.Minute))
		}

		// The lower(email) unique index must reject a case-only duplicate.
		other := mustCreateUser(t, ctx, users, now)
		if _, err := users.UpdateEmail(ctx, other.UID, "RENAMED-"+user.UID+"@EXAMPLE.TEST", now); !errors.Is(err, domain.ErrDuplicate) {
			t.Fatalf("大小写重复邮箱 error = %v; want ErrDuplicate", err)
		}
		if _, err := users.UpdateEmail(ctx, ulid.Make().String(), "nobody@example.test", now); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("改不存在用户的邮箱 error = %v; want ErrNotFound", err)
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
		before, err := r.Audit.Count(ctx, domain.AuditFilter{})
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

		after, err := r.Audit.Count(ctx, domain.AuditFilter{})
		if err != nil || after != before+2 {
			t.Fatalf("audit count = %d, %v; want %d", after, err, before+2)
		}

		logs, err := r.Audit.List(ctx, domain.AuditFilter{}, domain.Page{Limit: 50})
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

		// Filters: the two dialect implementations must agree on what "no
		// filter" and each individual filter mean, otherwise the admin audit
		// page shows different rows depending on the database.
		if n, err := r.Audit.Count(ctx, domain.AuditFilter{Action: domain.AuditUserDisable}); err != nil || n < 2 {
			t.Fatalf("count by action = %d, %v; want >= 2", n, err)
		}
		if n, err := r.Audit.Count(ctx, domain.AuditFilter{Action: "user.no_such_action"}); err != nil || n != 0 {
			t.Fatalf("count by unknown action = %d, %v; want 0", n, err)
		}
		if n, err := r.Audit.Count(ctx, domain.AuditFilter{ActorID: &actor.ID}); err != nil || n != 2 {
			t.Fatalf("count by actor = %d, %v; want 2", n, err)
		}

		window, err := r.Audit.List(ctx, domain.AuditFilter{
			ActorID: &actor.ID,
			From:    timePtr(now.Add(-time.Minute)),
			To:      timePtr(now.Add(time.Minute)),
		}, domain.Page{Limit: 50})
		if err != nil {
			t.Fatalf("list audit logs by window: %v", err)
		}
		if len(window) != 2 {
			t.Fatalf("window list returned %d entries; want 2", len(window))
		}
		// A window that ends before the records must return nothing — this is
		// the case that breaks if timestamps are stored in mismatched formats.
		if n, err := r.Audit.Count(ctx, domain.AuditFilter{
			ActorID: &actor.ID,
			To:      timePtr(now.Add(-time.Hour)),
		}); err != nil || n != 0 {
			t.Fatalf("count with past upper bound = %d, %v; want 0", n, err)
		}
	})

	t.Run("share link lifecycle, join fields, and revoke semantics", func(t *testing.T) {
		shares := r.Shares
		owner := mustCreateUser(t, ctx, users, now)
		other := mustCreateUser(t, ctx, users, now)

		doc := []byte(`{"format":"wmind","formatVersion":"1.0","sheets":[{"id":"s1"}]}`)
		target, err := maps.Create(ctx, domain.CreateMapInput{
			UID: ulid.Make().String(), OwnerID: owner.ID, Title: "Contract Share Map",
			Document: doc, NodeCount: 1, SizeBytes: int64(len(doc)), Now: now,
		})
		if err != nil {
			t.Fatalf("create map for share: %v", err)
		}

		expires := now.Add(7 * 24 * time.Hour)
		link, err := shares.Create(ctx, domain.CreateShareInput{
			UID: ulid.Make().String(), Token: "tok-" + ulid.Make().String(),
			MapID: target.ID, OwnerID: owner.ID, PasswordHash: "bcrypt-hash",
			AllowDownload: false, ShowNotes: false, ExpiresAt: &expires, Now: now,
		})
		if err != nil {
			t.Fatalf("create share: %v", err)
		}
		if link.AllowDownload || link.ShowNotes {
			t.Fatalf("booleans not stored: %#v", link)
		}
		if link.ExpiresAt == nil || !link.ExpiresAt.Equal(expires) {
			t.Fatalf("expires_at mismatch: %v, want %v", link.ExpiresAt, expires)
		}
		if !link.CreatedAt.Equal(now) {
			t.Fatalf("created_at mismatch: %v, want %v", link.CreatedAt, now)
		}

		// GetByUID carries the joined map fields -- every list surface shows them.
		got, err := shares.GetByUID(ctx, link.UID, owner.ID)
		if err != nil {
			t.Fatalf("GetByUID: %v", err)
		}
		if got.MapUID != target.UID || got.MapTitle != target.Title {
			t.Fatalf("join fields missing: uid=%q title=%q", got.MapUID, got.MapTitle)
		}
		// A different owner must see "not found", never "forbidden".
		if _, err := shares.GetByUID(ctx, link.UID, other.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner GetByUID = %v; want ErrNotFound", err)
		}

		// GetByToken returns the document and the owner nickname in one round trip.
		byToken, err := shares.GetByToken(ctx, link.Token)
		if err != nil {
			t.Fatalf("GetByToken: %v", err)
		}
		if !sameJSON(t, string(byToken.Document), string(doc)) {
			t.Fatalf("document mismatch: %s", byToken.Document)
		}
		if byToken.MapDeleted {
			t.Fatal("freshly created map reported as deleted")
		}
		if byToken.OwnerNickname != owner.Nickname {
			t.Fatalf("owner nickname = %q, want %q", byToken.OwnerNickname, owner.Nickname)
		}
		if _, err := shares.GetByToken(ctx, "no-such-token"); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("unknown token = %v; want ErrNotFound", err)
		}

		// A second link, so listing and counting have something to compare.
		second, err := shares.Create(ctx, domain.CreateShareInput{
			UID: ulid.Make().String(), Token: "tok2-" + ulid.Make().String(),
			MapID: target.ID, OwnerID: owner.ID, AllowDownload: true, ShowNotes: true, Now: now,
		})
		if err != nil {
			t.Fatalf("create second share: %v", err)
		}

		byMap, err := shares.ListByMap(ctx, target.ID, owner.ID)
		if err != nil {
			t.Fatalf("ListByMap: %v", err)
		}
		if len(byMap) != 2 {
			t.Fatalf("ListByMap = %d rows; want 2", len(byMap))
		}
		if byMap[0].ID != second.ID {
			t.Fatalf("ListByMap is not newest-first: %#v", byMap[0])
		}

		if n, err := shares.CountActiveByMap(ctx, target.ID); err != nil || n != 2 {
			t.Fatalf("CountActiveByMap = %d, %v; want 2", n, err)
		}

		mine, err := shares.ListByOwner(ctx, owner.ID, "", domain.NewPage(1, 20))
		if err != nil {
			t.Fatalf("ListByOwner: %v", err)
		}
		if len(mine) != 2 {
			t.Fatalf("ListByOwner = %d rows; want 2", len(mine))
		}
		// The optional map_uid filter must narrow, not widen.
		if rows, err := shares.ListByOwner(ctx, owner.ID, target.UID, domain.NewPage(1, 20)); err != nil || len(rows) != 2 {
			t.Fatalf("filter by existing map = %d rows, %v; want 2", len(rows), err)
		}
		if rows, err := shares.ListByOwner(ctx, owner.ID, ulid.Make().String(), domain.NewPage(1, 20)); err != nil || len(rows) != 0 {
			t.Fatalf("filter by unknown map = %d rows, %v; want 0", len(rows), err)
		}
		if n, err := shares.CountByOwner(ctx, owner.ID, ""); err != nil || n != 2 {
			t.Fatalf("CountByOwner = %d, %v; want 2", n, err)
		}
		if rows, err := shares.ListByOwner(ctx, other.ID, "", domain.NewPage(1, 20)); err != nil || len(rows) != 0 {
			t.Fatalf("other owner sees %d rows, %v; want 0", len(rows), err)
		}

		// Update is a full write: passing nil expires_at clears the expiry.
		updated, err := shares.Update(ctx, domain.UpdateShareInput{
			UID: link.UID, OwnerID: owner.ID, PasswordHash: "",
			AllowDownload: true, ShowNotes: true, ExpiresAt: nil,
		})
		if err != nil {
			t.Fatalf("Update: %v", err)
		}
		if updated.PasswordHash != "" || !updated.AllowDownload || !updated.ShowNotes || updated.ExpiresAt != nil {
			t.Fatalf("update did not apply every field: %#v", updated)
		}

		// View counting.
		if err := shares.RecordView(ctx, link.ID, now.Add(time.Minute)); err != nil {
			t.Fatalf("RecordView: %v", err)
		}
		afterView, err := shares.GetByUID(ctx, link.UID, owner.ID)
		if err != nil {
			t.Fatalf("GetByUID after view: %v", err)
		}
		if afterView.ViewCount != 1 || afterView.LastViewedAt == nil {
			t.Fatalf("view not recorded: count=%d last=%v", afterView.ViewCount, afterView.LastViewedAt)
		}

		// Revoke keeps the row (statistics survive) but blocks further writes.
		if err := shares.Revoke(ctx, link.UID, owner.ID, now); err != nil {
			t.Fatalf("Revoke: %v", err)
		}
		revoked, err := shares.GetByUID(ctx, link.UID, owner.ID)
		if err != nil {
			t.Fatalf("GetByUID after revoke: %v", err)
		}
		if !revoked.Revoked() || revoked.ViewCount != 1 {
			t.Fatalf("revoke lost data: %#v", revoked)
		}
		if err := shares.Revoke(ctx, link.UID, owner.ID, now); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("second revoke = %v; want ErrNotFound", err)
		}
		if _, err := shares.Update(ctx, domain.UpdateShareInput{
			UID: link.UID, OwnerID: owner.ID, AllowDownload: true,
		}); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("update after revoke = %v; want ErrNotFound", err)
		}
		if n, err := shares.CountActiveByMap(ctx, target.ID); err != nil || n != 1 {
			t.Fatalf("CountActiveByMap after revoke = %d, %v; want 1", n, err)
		}

		// Soft-deleting the map must surface through GetByToken, not as an error:
		// the caller folds it into the same 404 as a revoked token.
		if err := maps.SoftDelete(ctx, target.UID, owner.ID, now); err != nil {
			t.Fatalf("SoftDelete map: %v", err)
		}
		trashed, err := shares.GetByToken(ctx, second.Token)
		if err != nil {
			t.Fatalf("GetByToken after map delete: %v", err)
		}
		if !trashed.MapDeleted {
			t.Fatal("map deleted but MapDeleted is false")
		}
	})

	t.Run("user template lifecycle, document round-trip, and owner isolation", func(t *testing.T) {
		templates := r.Templates
		owner := mustCreateUser(t, ctx, users, now)
		other := mustCreateUser(t, ctx, users, now)

		// A document with a number large enough to lose precision if anything
		// along the way decodes it as float64 (2^24 + 1).
		doc := []byte(`{"format":"wmind","formatVersion":"1.0","id":"d1","title":"模板源",` +
			`"sheets":[{"id":"s1","structure":"org-chart","rootTopic":{"id":"r1","title":"中心","width":16777217}}]}`)

		created, err := templates.Create(ctx, domain.CreateTemplateInput{
			UID: ulid.Make().String(), OwnerID: owner.ID, Name: "组织架构模板",
			Category: domain.TemplateCategoryUser, Structure: "org-chart",
			Document: doc, ThumbnailURL: "/uploads/t1.png", Now: now,
		})
		if err != nil {
			t.Fatalf("create template: %v", err)
		}
		if created.IsBuiltin {
			t.Fatal("API-created template reported as built-in")
		}
		if created.SortOrder != 0 {
			t.Fatalf("sort_order = %d, want 0", created.SortOrder)
		}
		if created.ThumbnailURL != "/uploads/t1.png" {
			t.Fatalf("thumbnail_url = %q", created.ThumbnailURL)
		}
		if !created.CreatedAt.Equal(now) {
			t.Fatalf("created_at mismatch: %v, want %v", created.CreatedAt, now)
		}
		if !sameJSON(t, string(created.Document), string(doc)) {
			t.Fatalf("document round-trip mismatch: %s", created.Document)
		}

		// GetByUID returns the full document; the list must NOT.
		got, err := templates.GetByUID(ctx, created.UID, owner.ID)
		if err != nil {
			t.Fatalf("GetByUID: %v", err)
		}
		if !sameJSON(t, string(got.Document), string(doc)) {
			t.Fatalf("GetByUID document mismatch: %s", got.Document)
		}
		if _, err := templates.GetByUID(ctx, created.UID, other.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner GetByUID = %v; want ErrNotFound", err)
		}

		listed, err := templates.ListByOwner(ctx, owner.ID)
		if err != nil {
			t.Fatalf("ListByOwner: %v", err)
		}
		if len(listed) != 1 || listed[0].UID != created.UID {
			t.Fatalf("ListByOwner = %#v", listed)
		}
		if len(listed[0].Document) != 0 {
			t.Fatalf("list carried the document (%d bytes); it must not", len(listed[0].Document))
		}
		if listed[0].Structure != "org-chart" {
			t.Fatalf("list structure = %q, want org-chart", listed[0].Structure)
		}
		if others, err := templates.ListByOwner(ctx, other.ID); err != nil || len(others) != 0 {
			t.Fatalf("other owner list = %#v, %v; want empty", others, err)
		}

		if n, err := templates.CountByOwner(ctx, owner.ID); err != nil || n != 1 {
			t.Fatalf("CountByOwner = %d, %v; want 1", n, err)
		}

		renamed, err := templates.Rename(ctx, domain.RenameTemplateInput{
			UID: created.UID, OwnerID: owner.ID, Name: "改名后", Now: now.Add(time.Minute),
		})
		if err != nil {
			t.Fatalf("Rename: %v", err)
		}
		if renamed.Name != "改名后" {
			t.Fatalf("name = %q", renamed.Name)
		}
		// Renaming must not touch the document.
		if !sameJSON(t, string(renamed.Document), string(doc)) {
			t.Fatalf("rename changed the document: %s", renamed.Document)
		}
		if _, err := templates.Rename(ctx, domain.RenameTemplateInput{
			UID: created.UID, OwnerID: other.ID, Name: "抢", Now: now,
		}); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner Rename = %v; want ErrNotFound", err)
		}

		if err := templates.Delete(ctx, created.UID, other.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner Delete = %v; want ErrNotFound", err)
		}
		if err := templates.Delete(ctx, created.UID, owner.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if err := templates.Delete(ctx, created.UID, owner.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("second Delete = %v; want ErrNotFound", err)
		}
		if _, err := templates.GetByUID(ctx, created.UID, owner.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("GetByUID after delete = %v; want ErrNotFound", err)
		}
	})

	t.Run("custom theme lifecycle, JSON config round-trip, and owner isolation", func(t *testing.T) {
		themes := r.Themes
		owner := mustCreateUser(t, ctx, users, now)
		other := mustCreateUser(t, ctx, users, now)

		// 与模板同一个理由：2^24 + 1 一旦被当成 float64 解码就会变成 16777216。
		config := []byte(`{"id":"custom-1","name":"我的配色","category":"custom",` +
			`"palette":{"colors":["#112233"],"lineColors":["#445566"],"backgroundColor":"#FFFFFF"},` +
			`"global":{"fontSize":14,"lineWidth":16777217}}`)

		created, err := themes.Create(ctx, domain.CreateThemeInput{
			UID: ulid.Make().String(), OwnerID: owner.ID, Name: "我的配色",
			Category: domain.ThemeCategoryCustom, Config: config, Now: now,
		})
		if err != nil {
			t.Fatalf("create theme: %v", err)
		}
		if created.ID <= 0 || created.UID == "" {
			t.Fatalf("created theme has no identity: %#v", created)
		}
		// 接口建出来的主题按定义就是用户主题：is_builtin 是写死的 false，
		// 否则一个构造出来的请求就能造出删不掉的「内置」行。
		if created.IsBuiltin {
			t.Fatal("API-created theme reported as built-in")
		}
		if created.SortOrder != 0 {
			t.Fatalf("sort_order = %d, want 0", created.SortOrder)
		}
		if created.Category != domain.ThemeCategoryCustom {
			t.Fatalf("category = %q, want %q", created.Category, domain.ThemeCategoryCustom)
		}
		if created.OwnerID == nil || *created.OwnerID != owner.ID {
			t.Fatalf("owner_id = %v, want %d", created.OwnerID, owner.ID)
		}
		if !created.CreatedAt.Equal(now) || !created.UpdatedAt.Equal(now) {
			t.Fatalf("timestamps = %v / %v, want %v", created.CreatedAt, created.UpdatedAt, now)
		}
		if !sameJSON(t, string(created.Config), string(config)) {
			t.Fatalf("config round-trip mismatch: %s", created.Config)
		}

		got, err := themes.GetByUID(ctx, created.UID, owner.ID)
		if err != nil {
			t.Fatalf("GetByUID: %v", err)
		}
		if !sameJSON(t, string(got.Config), string(config)) {
			t.Fatalf("GetByUID config mismatch: %s", got.Config)
		}
		// 跨用户访问一律「查不到」而不是「无权限」——后者会泄露 uid 是否存在。
		if _, err := themes.GetByUID(ctx, created.UID, other.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner GetByUID = %v; want ErrNotFound", err)
		}

		// 列表按 sort_order, created_at 升序；两行 sort_order 都是 0，
		// 所以顺序由创建时间决定。
		second, err := themes.Create(ctx, domain.CreateThemeInput{
			UID: ulid.Make().String(), OwnerID: owner.ID, Name: "第二套",
			Category: domain.ThemeCategoryCustom, Config: config, Now: now.Add(time.Second),
		})
		if err != nil {
			t.Fatalf("create second theme: %v", err)
		}
		listed, err := themes.ListByOwner(ctx, owner.ID)
		if err != nil {
			t.Fatalf("ListByOwner: %v", err)
		}
		if len(listed) != 2 || listed[0].UID != created.UID || listed[1].UID != second.UID {
			t.Fatalf("ListByOwner order = %#v, want [%s %s]", listed, created.UID, second.UID)
		}
		if others, err := themes.ListByOwner(ctx, other.ID); err != nil || len(others) != 0 {
			t.Fatalf("other owner list = %#v, %v; want empty", others, err)
		}
		if n, err := themes.CountByOwner(ctx, owner.ID); err != nil || n != 2 {
			t.Fatalf("CountByOwner = %d, %v; want 2", n, err)
		}

		// 改名 + 换配色。uid / category / created_at 都不该动。
		updatedConfig := []byte(`{"id":"custom-1","name":"改过名","category":"custom","palette":{"colors":["#000000"],"lineColors":["#000000"],"backgroundColor":"#FFFFFF"},"global":{"fontSize":16,"lineWidth":2}}`)
		renamed, err := themes.Update(ctx, domain.UpdateThemeInput{
			UID: created.UID, OwnerID: owner.ID, Name: "改过名",
			Config: updatedConfig, Now: now.Add(2 * time.Minute),
		})
		if err != nil {
			t.Fatalf("Update: %v", err)
		}
		if renamed.Name != "改过名" {
			t.Fatalf("name = %q", renamed.Name)
		}
		if !sameJSON(t, string(renamed.Config), string(updatedConfig)) {
			t.Fatalf("updated config mismatch: %s", renamed.Config)
		}
		if renamed.Category != domain.ThemeCategoryCustom || renamed.UID != created.UID {
			t.Fatalf("update changed identity fields: %#v", renamed)
		}
		if !renamed.CreatedAt.Equal(created.CreatedAt) {
			t.Fatalf("created_at changed on update: %v -> %v", created.CreatedAt, renamed.CreatedAt)
		}
		if !renamed.UpdatedAt.Equal(now.Add(2 * time.Minute)) {
			t.Fatalf("updated_at = %v", renamed.UpdatedAt)
		}
		if _, err := themes.Update(ctx, domain.UpdateThemeInput{
			UID: created.UID, OwnerID: other.ID, Name: "抢", Config: updatedConfig, Now: now,
		}); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner Update = %v; want ErrNotFound", err)
		}

		if err := themes.Delete(ctx, created.UID, other.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("cross-owner Delete = %v; want ErrNotFound", err)
		}
		if err := themes.Delete(ctx, created.UID, owner.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if err := themes.Delete(ctx, created.UID, owner.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("second Delete = %v; want ErrNotFound", err)
		}
		if _, err := themes.GetByUID(ctx, created.UID, owner.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("GetByUID after delete = %v; want ErrNotFound", err)
		}
		if n, err := themes.CountByOwner(ctx, owner.ID); err != nil || n != 1 {
			t.Fatalf("CountByOwner after delete = %d, %v; want 1", n, err)
		}
	})
}

func timePtr(t time.Time) *time.Time { return &t }

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
