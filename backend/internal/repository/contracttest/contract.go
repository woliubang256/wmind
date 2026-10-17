// Package contracttest contains reusable behavioral tests for every dialect's
// domain repository implementations. Driver-specific Test files supply real
// migrated databases and call Run.
package contracttest

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

func Run(t *testing.T, users domain.UserRepo, maps domain.MapRepo, tx domain.TxManager) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	uid := ulid.Make().String()

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
}
