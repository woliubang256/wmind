package service

import (
	"context"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

// Read a snapshot, complete another request, then let this request write. This
// reproduces the database interleaving without timers or nondeterministic races.
type interleavedProfileRead struct {
	domain.UserRepo
	afterRead func()
}

func (r *interleavedProfileRead) GetByUID(ctx context.Context, uid string) (*domain.User, error) {
	user, err := r.UserRepo.GetByUID(ctx, uid)
	if err == nil && r.afterRead != nil {
		afterRead := r.afterRead
		r.afterRead = nil
		afterRead()
	}
	return user, err
}

func TestProfileChangesPreserveConcurrentAvatar(t *testing.T) {
	svc, users, store := newUserFixture(t)
	user := mustSeedUser(t, users, "alice", "alice@example.com")
	ctx := t.Context()
	if _, err := svc.UpdateAvatar(ctx, user.UID, testPNG(t, 8, 8)); err != nil {
		t.Fatal(err)
	}
	var uploaded *domain.User
	repo := &interleavedProfileRead{UserRepo: users, afterRead: func() {
		var err error
		uploaded, err = svc.UpdateAvatar(ctx, user.UID, testPNG(t, 12, 12))
		if err != nil {
			t.Fatal(err)
		}
	}}
	interleaved, err := NewUserService(repo, UserServiceConfig{Avatars: store, Tx: fakeTxManager{}})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := interleaved.UpdateProfile(ctx, user.UID, ProfileUpdate{Nickname: ptr("new name")})
	if err != nil {
		t.Fatal(err)
	}
	if updated.AvatarURL != uploaded.AvatarURL || updated.Nickname != "new name" {
		t.Fatalf("nickname update restored an old avatar: got %#v, uploaded %q", updated, uploaded.AvatarURL)
	}
}

func TestAvatarChangesPreserveConcurrentNickname(t *testing.T) {
	svc, users, store := newUserFixture(t)
	user := mustSeedUser(t, users, "alice", "alice@example.com")
	ctx := t.Context()
	repo := &interleavedProfileRead{UserRepo: users, afterRead: func() {
		if _, err := svc.UpdateProfile(ctx, user.UID, ProfileUpdate{Nickname: ptr("new name")}); err != nil {
			t.Fatal(err)
		}
	}}
	interleaved, err := NewUserService(repo, UserServiceConfig{Avatars: store, Tx: fakeTxManager{}})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := interleaved.UpdateAvatar(ctx, user.UID, testPNG(t, 8, 8))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Nickname != "new name" || updated.AvatarURL == "" {
		t.Fatalf("avatar update restored an old nickname: %#v", updated)
	}
}
