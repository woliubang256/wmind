package contracttest

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

func RunUploadReferences(t *testing.T, refs domain.UploadReferencesRepo, users domain.UserRepo, maps domain.MapRepo, templates domain.TemplateRepo, settings domain.SettingsRepo) {
	t.Helper()
	ctx, now := t.Context(), time.Now().UTC()
	prefix := ulid.Make().String()
	u, err := users.Create(ctx, domain.CreateUserInput{UID: prefix, Username: prefix, Email: prefix + "@example.test", PasswordHash: "hash", Nickname: "ref", AvatarURL: "/uploads/active-avatar", Role: domain.RoleUser, Status: domain.UserStatusDisabled, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := users.Create(ctx, domain.CreateUserInput{UID: prefix + "del", Username: prefix + "del", Email: prefix + "del@example.test", PasswordHash: "hash", AvatarURL: "/uploads/deleted-avatar", Role: domain.RoleUser, Status: domain.UserStatusActive, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if err := users.SoftDelete(ctx, deleted.UID, now); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 105; i++ {
		m, err := maps.Create(ctx, domain.CreateMapInput{UID: fmt.Sprintf("%s-%d", prefix, i), OwnerID: u.ID, Title: "reference", Document: []byte(fmt.Sprintf(`{"image":{"src":"/uploads/document-%s-%d"}}`, prefix, i)), Now: now})
		if err != nil {
			t.Fatal(err)
		}
		if err := maps.UpdateThumbnail(ctx, m.UID, u.ID, fmt.Sprintf("/uploads/thumb-%s-%d", prefix, i), now); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			if err := maps.SoftDelete(ctx, m.UID, u.ID, now); err != nil {
				t.Fatal(err)
			}
		}
	}
	_, err = templates.Create(ctx, domain.CreateTemplateInput{UID: prefix, OwnerID: u.ID, Name: "template", Category: domain.TemplateCategoryUser, Structure: "mindmap", Document: []byte(`{"image":{"src":"/uploads/template-image"}}`), ThumbnailURL: "/uploads/template-cover", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if err := settings.Upsert(ctx, "site.logo", `"/uploads/site-logo"`, &u.ID, now); err != nil {
		t.Fatal(err)
	}
	urls, documents, settingValues := map[string]bool{}, "", ""
	err = refs.VisitUploadReferences(ctx, func(ref domain.UploadReference) error {
		urls[ref.URL] = true
		documents += string(ref.Document)
		settingValues += string(ref.Setting)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 105; i++ {
		if !urls[fmt.Sprintf("/uploads/thumb-%s-%d", prefix, i)] || !strings.Contains(documents, fmt.Sprintf("/uploads/document-%s-%d", prefix, i)) {
			t.Fatalf("lost map reference %d", i)
		}
	}
	if !urls["/uploads/active-avatar"] || urls["/uploads/deleted-avatar"] {
		t.Fatalf("avatar lifecycle %+v", urls)
	}
	if !urls["/uploads/template-cover"] || !strings.Contains(documents, "/uploads/template-image") || !strings.Contains(settingValues, "/uploads/site-logo") {
		t.Fatal("template or settings reference missing")
	}
	want := errors.New("stop visitor")
	if err := refs.VisitUploadReferences(ctx, func(domain.UploadReference) error { return want }); !errors.Is(err, want) {
		t.Fatalf("visitor error swallowed: %v", err)
	}
}
