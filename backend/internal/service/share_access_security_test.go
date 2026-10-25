package service

import (
	"context"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

func TestSharePasswordResetRevokesPreviouslyVerifiedAccess(t *testing.T) {
	for _, nextPassword := range []string{"Zy8q", "Ab4x"} {
		t.Run(nextPassword, func(t *testing.T) {
			f := newShareFixture(t, defaultSharePolicy())
			ctx := context.Background()
			mapUID, _ := f.seedMap(t, 1, "private-map")
			link, err := f.svc.Create(ctx, mapUID, 1, CreateShareInput{Password: "Ab4x"})
			if err != nil {
				t.Fatal(err)
			}
			oldAccess, _, err := f.svc.VerifyPassword(ctx, link.Token, "Ab4x")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.Update(ctx, link.UID, 1, UpdateShareInput{Password: &nextPassword}); err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.ReadPublic(ctx, link.Token, oldAccess, "127.0.0.1"); codeOf(t, err) != apperr.CodeSharePasswordRequired {
				t.Errorf("access issued before password reset = %v; want SHARE_PASSWORD_REQUIRED", err)
			}
			freshAccess, _, err := f.svc.VerifyPassword(ctx, link.Token, nextPassword)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.ReadPublic(ctx, link.Token, freshAccess, "127.0.0.1"); err != nil {
				t.Errorf("newly verified access rejected: %v", err)
			}
		})
	}
}

func TestShareAccessSurvivesUnrelatedSettingsAndNotPasswordRemoval(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	ctx := context.Background()
	mapUID, _ := f.seedMap(t, 1, "private-map")
	link, err := f.svc.Create(ctx, mapUID, 1, CreateShareInput{Password: "Ab4x"})
	if err != nil {
		t.Fatal(err)
	}
	access, _, err := f.svc.VerifyPassword(ctx, link.Token, "Ab4x")
	if err != nil {
		t.Fatal(err)
	}
	allow, notes, days := false, true, 7
	if _, err := f.svc.Update(ctx, link.UID, 1, UpdateShareInput{AllowDownload: &allow, ShowNotes: &notes, ExpiresInDays: &days}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ReadPublic(ctx, link.Token, access, "127.0.0.1"); err != nil {
		t.Fatalf("unrelated settings invalidated the current credential: %v", err)
	}
	empty, original := "", "Ab4x"
	if _, err := f.svc.Update(ctx, link.UID, 1, UpdateShareInput{Password: &empty}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ReadPublic(ctx, link.Token, "", "127.0.0.1"); err != nil {
		t.Fatalf("cleared password should allow anonymous read: %v", err)
	}
	if _, err := f.svc.Update(ctx, link.UID, 1, UpdateShareInput{Password: &original}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ReadPublic(ctx, link.Token, access, "127.0.0.1"); codeOf(t, err) != apperr.CodeSharePasswordRequired {
		t.Errorf("reinstating the same password restored an old credential: %v", err)
	}
}

func TestShareAccessDoesNotCrossMapOrOwner(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	ctx := context.Background()
	firstMap, _ := f.seedMap(t, 1, "first-map")
	first, err := f.svc.Create(ctx, firstMap, 1, CreateShareInput{Password: "Ab4x"})
	if err != nil {
		t.Fatal(err)
	}
	access, _, err := f.svc.VerifyPassword(ctx, first.Token, "Ab4x")
	if err != nil {
		t.Fatal(err)
	}
	for _, ownerID := range []int64{1, 2} {
		mapUID, _ := f.seedMap(t, ownerID, "other-map")
		other, err := f.svc.Create(ctx, mapUID, ownerID, CreateShareInput{Password: "Ab4x"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.ReadPublic(ctx, other.Token, access, "127.0.0.1"); codeOf(t, err) != apperr.CodeSharePasswordRequired {
			t.Errorf("credential read owner %d's other map: %v", ownerID, err)
		}
	}
}

// A delayed PATCH may have read its row before another request changed the
// password. Returning that snapshot makes the race deterministic without sleeps.
type staleShareReadRepo struct {
	domain.ShareRepo
	snapshot *domain.ShareLink
}

func (r staleShareReadRepo) GetByUID(context.Context, string, int64) (*domain.ShareLink, error) {
	copy := *r.snapshot
	return &copy, nil
}

func TestShareStaleSettingsUpdateCannotRestorePreviousPassword(t *testing.T) {
	f := newShareFixture(t, defaultSharePolicy())
	ctx := context.Background()
	mapUID, _ := f.seedMap(t, 1, "private-map")
	link, err := f.svc.Create(ctx, mapUID, 1, CreateShareInput{Password: "Ab4x"})
	if err != nil {
		t.Fatal(err)
	}
	oldAccess, _, err := f.svc.VerifyPassword(ctx, link.Token, "Ab4x")
	if err != nil {
		t.Fatal(err)
	}
	next := "Zy8q"
	if _, err := f.svc.Update(ctx, link.UID, 1, UpdateShareInput{Password: &next}); err != nil {
		t.Fatal(err)
	}
	delayed := *f.svc
	delayed.shares = staleShareReadRepo{ShareRepo: f.shares, snapshot: link}
	notes := true
	if _, err := delayed.Update(ctx, link.UID, 1, UpdateShareInput{ShowNotes: &notes}); codeOf(t, err) != apperr.CodeShareNotFound {
		t.Errorf("stale settings update = %v; want failure instead of restoring old password", err)
	}
	if _, _, err := f.svc.VerifyPassword(ctx, link.Token, next); err != nil {
		t.Errorf("new password was overwritten: %v", err)
	}
	if _, _, err := f.svc.VerifyPassword(ctx, link.Token, "Ab4x"); codeOf(t, err) != apperr.CodeSharePasswordInvalid {
		t.Errorf("previous password became valid again: %v", err)
	}
	if _, err := f.svc.ReadPublic(ctx, link.Token, oldAccess, "127.0.0.1"); codeOf(t, err) != apperr.CodeSharePasswordRequired {
		t.Errorf("previous access credential became valid again: %v", err)
	}
}
