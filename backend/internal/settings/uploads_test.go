package settings_test

import (
	"context"
	"errors"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/settings"
)

func TestLocalLogoRequiresExistingUploadBeforeAnyWrite(t *testing.T) {
	repo := newFakeRepo()
	var checked string
	svc, err := settings.New(repo, settings.Config{UploadExists: func(_ context.Context, key string) (bool, error) { checked = key; return key == "live.png", nil }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(t.Context(), map[string]any{"site.name": "must not change", "site.logo": "/uploads/gone.png"}, nil); err == nil {
		t.Fatal("missing logo accepted")
	}
	if repo.writes != 0 {
		t.Fatal("partial settings were saved")
	}
	if _, err := svc.Update(t.Context(), map[string]any{"site.logo": "/uploads/live.png?v=1#preview"}, nil); err != nil || checked != "live.png" {
		t.Fatalf("existing query URL: %s %v", checked, err)
	}
	checked = ""
	if _, err := svc.Update(t.Context(), map[string]any{"site.logo": "https://external.invalid/logo.png"}, nil); err != nil || checked != "" {
		t.Fatalf("external logo wrongly checked: %v", err)
	}
	broken, err := settings.New(newFakeRepo(), settings.Config{UploadExists: func(context.Context, string) (bool, error) { return false, errors.New("storage unavailable") }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broken.Update(t.Context(), map[string]any{"site.logo": "/uploads/live.png"}, nil); err == nil {
		t.Fatal("storage failure allowed binding")
	}
}
