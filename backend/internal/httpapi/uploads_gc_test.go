package httpapi_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/uploadgc"
)

func TestMissingUploadCannotBeBoundAgain(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("collectedupload")
	_, uploaded := s.uploadFile(token, "file", "thumbnail.png", "image/png", pngBytes(t, 4, 4))
	path := uploaded.Data["url"].(string)
	if err := os.Remove(filepath.Join(s.uploads, strings.TrimPrefix(path, "/uploads/"))); err != nil {
		t.Fatal(err)
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{"document": docWithImage(path)}); status != http.StatusUnprocessableEntity {
		t.Errorf("missing image binding = %d; want 422", status)
	}
	uid := s.createMap(token, "new cover")
	if status, _ := s.do(http.MethodPut, "/api/v1/maps/"+uid+"/thumbnail", token, map[string]any{"thumbnailUrl": path}); status != http.StatusUnprocessableEntity {
		t.Errorf("missing thumbnail binding = %d; want 422", status)
	}
	avatar := "/uploads/avatar_01JAAAAAAAAAAAAAAAAAAAAAAA_01JBBBBBBBBBBBBBBBBBBBBBBB.png"
	if status, _ := s.do(http.MethodPut, "/api/v1/maps/"+uid+"/thumbnail", token, map[string]any{"thumbnailUrl": avatar}); status != http.StatusUnprocessableEntity {
		t.Errorf("missing avatar binding = %d; want 422", status)
	}
}

func TestUploadCollectionKeepsTemplatesTrashAndFreshBindings(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("gclifecycle")
	now := time.Now().UTC()
	paths := []string{}
	for range 4 {
		status, uploaded := s.uploadFile(token, "file", "thumbnail.png", "image/png", pngBytes(t, 4, 4))
		if status != http.StatusOK {
			t.Fatal(status)
		}
		path := uploaded.Data["url"].(string)
		for _, previous := range paths {
			if previous == path {
				t.Fatal("uploads reused a file URL")
			}
		}
		paths = append(paths, path)
		name := filepath.Join(s.uploads, strings.TrimPrefix(path, "/uploads/"))
		if err := os.Chtimes(name, now.Add(-48*time.Hour), now.Add(-48*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	status, created := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{"document": docWithImage(paths[1])})
	if status != http.StatusCreated {
		t.Fatalf("create = %d %+v", status, created.Error)
	}
	uid := created.Data["uid"].(string)
	setCover := func(path string) {
		t.Helper()
		if status, _ := s.do(http.MethodPut, "/api/v1/maps/"+uid+"/thumbnail", token, map[string]any{"thumbnailUrl": path}); status != http.StatusNoContent {
			t.Fatal(status)
		}
	}
	setCover(paths[2])
	template := s.createTemplate(token, uid, "retains old cover")
	setCover(paths[3])
	if status, _ := s.do(http.MethodDelete, "/api/v1/maps/"+uid, token, nil); status != http.StatusNoContent {
		t.Fatal(status)
	}
	cleaner, err := uploadgc.New(uploadgc.Config{Root: s.uploads, References: sqlite.NewUploadReferencesRepository(s.db), Gate: s.backups.Gate(), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	check := func(want int) {
		t.Helper()
		if n, err := cleaner.Sweep(t.Context()); err != nil || n != want {
			t.Fatalf("GC=%d,%v want=%d", n, err, want)
		}
	}
	check(0)
	now = now.Add(24 * time.Hour)
	check(1)
	for _, path := range paths[1:] {
		if _, err := os.Stat(filepath.Join(s.uploads, strings.TrimPrefix(path, "/uploads/"))); err != nil {
			t.Fatalf("live reference removed: %s", path)
		}
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/trash/"+uid, token, nil); status != http.StatusNoContent {
		t.Fatal(status)
	}
	check(0)
	now = now.Add(24 * time.Hour)
	check(1)
	if status, _ := s.do(http.MethodDelete, "/api/v1/templates/"+template["uid"].(string), token, nil); status != http.StatusNoContent {
		t.Fatal(status)
	}
	check(0)
	now = now.Add(24 * time.Hour)
	check(2)
	if status, _ := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{"document": docWithImage(paths[1])}); status != http.StatusUnprocessableEntity {
		t.Fatalf("collected asset rebound: %d", status)
	}
}

func TestUploadCollectionPreservesSiteLogoAfterAccountDeletion(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("gclogo")
	_, me := s.do(http.MethodGet, "/api/v1/auth/me", token, nil)
	uid := me.Data["uid"].(string)
	_, first := s.upload("/api/v1/users/me/avatar", token, "first.png", pngBytes(t, 4, 4))
	logo := first.Data["avatarUrl"].(string)
	_, second := s.upload("/api/v1/users/me/avatar", token, "second.png", pngBytes(t, 4, 4))
	unused := second.Data["avatarUrl"].(string)
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	if status, _ := s.do(http.MethodPut, "/api/v1/admin/settings", admin, map[string]any{"site.logo": logo}); status != http.StatusOK {
		t.Fatal(status)
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/admin/users/"+uid, admin, nil); status != http.StatusNoContent {
		t.Fatal(status)
	}
	now := time.Now().Add(48 * time.Hour)
	cleaner, err := uploadgc.New(uploadgc.Config{Root: s.uploads, References: sqlite.NewUploadReferencesRepository(s.db), Gate: s.backups.Gate(), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cleaner.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(24 * time.Hour)
	if n, err := cleaner.Sweep(t.Context()); n != 1 || err != nil {
		t.Fatalf("deleted account cleanup=%d,%v", n, err)
	}
	if _, err := os.Stat(filepath.Join(s.uploads, strings.TrimPrefix(logo, "/uploads/"))); err != nil {
		t.Fatal("site logo removed")
	}
	if _, err := os.Stat(filepath.Join(s.uploads, strings.TrimPrefix(unused, "/uploads/"))); !os.IsNotExist(err) {
		t.Fatal("deleted user's unused avatar retained")
	}
	if status, _ := s.do(http.MethodPut, "/api/v1/admin/settings", admin, map[string]any{"site.logo": unused}); status != http.StatusUnprocessableEntity {
		t.Fatalf("missing logo accepted: %d", status)
	}
	if status, _ := s.do(http.MethodPut, "/api/v1/admin/settings", admin, map[string]any{"site.logo": ""}); status != http.StatusOK {
		t.Fatal(status)
	}
	if _, err := cleaner.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(24 * time.Hour)
	if n, err := cleaner.Sweep(t.Context()); n != 1 || err != nil {
		t.Fatalf("old site logo cleanup=%d,%v", n, err)
	}
}

func TestUploadCollectionPreservesPersistedRevisionImages(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("revisiongc")
	_, uploaded := s.uploadFile(token, "file", "history.png", "image/png", pngBytes(t, 4, 4))
	path := uploaded.Data["url"].(string)
	uid := s.createMap(token, "history-only image")
	if _, err := s.db.Exec(`INSERT INTO map_revisions(map_id,version,document) SELECT id,1,? FROM maps WHERE uid=?`, `{"image":{"src":"`+path+`"}}`, uid); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(48 * time.Hour)
	c, err := uploadgc.New(uploadgc.Config{Root: s.uploads, References: sqlite.NewUploadReferencesRepository(s.db), Gate: s.backups.Gate(), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(24 * time.Hour)
	if n, err := c.Sweep(t.Context()); err != nil || n != 0 {
		t.Fatalf("history-only image reclaimed: %d %v", n, err)
	}
}
