package httpapi_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/backup"
)

func TestBackupEndpointsRequireAdmin(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("backup-user")
	for _, route := range []struct{ method, path string }{{"GET", "/backups"}, {"PUT", "/backups/config"}, {"POST", "/backups/test"}, {"POST", "/backups/run"}, {"POST", "/backups/schedule"}, {"POST", "/backups/restore/preview"}, {"POST", "/backups/restore"}} {
		for _, tc := range []struct {
			token  string
			status int
		}{{"", 401}, {token, 403}} {
			status, body := s.do(route.method, "/api/v1/admin"+route.path, tc.token, map[string]any{})
			if status != tc.status {
				t.Fatalf("%s %s: %d %+v", route.method, route.path, status, body.Error)
			}
		}
	}
}
func TestBackupHTTPConfigurationScheduleAndRestore(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)
	var mu sync.Mutex
	var archive []byte
	dav := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "backup-user" || password != "backup-password" {
			w.WriteHeader(401)
			return
		}
		switch r.Method {
		case "PROPFIND":
			w.WriteHeader(207)
		case "PUT":
			raw, _ := io.ReadAll(r.Body)
			if strings.HasSuffix(r.URL.Path, ".zip") {
				mu.Lock()
				archive = raw
				mu.Unlock()
			}
			w.WriteHeader(201)
		case "DELETE":
			w.WriteHeader(204)
		default:
			w.WriteHeader(405)
		}
	}))
	defer dav.Close()
	c := backup.DefaultConfiguration()
	c.Enabled = true
	c.WebDAV = backup.WebDAVConfig{URL: dav.URL, Username: "backup-user", Password: "backup-password"}
	status, body := s.do("PUT", "/api/v1/admin/backups/config", token, c)
	if status != 200 {
		t.Fatalf("save: %d %+v", status, body.Error)
	}
	config := body.Data["configuration"].(map[string]any)
	if config["retainCount"] != float64(30) || config["skipUnchanged"] != false {
		t.Fatal("incorrect backup defaults", config)
	}
	davConfig := config["webdav"].(map[string]any)
	if davConfig["password"] != nil || davConfig["passwordSet"] != true {
		t.Fatal("secret leaked", davConfig)
	}
	status, body = s.do("GET", "/api/v1/admin/settings", token, nil)
	if status != 200 || body.Data["backup.config"] != nil {
		t.Fatal("private settings leaked")
	}
	status, body = s.do("POST", "/api/v1/admin/backups/schedule", token, map[string]string{"cron": "*/15 * * * *", "timezone": "Asia/Shanghai"})
	if status != 200 || len(body.Data["nextRuns"].([]any)) != 5 {
		t.Fatalf("schedule %d %+v", status, body)
	}
	status, _ = s.do("POST", "/api/v1/admin/backups/schedule", token, map[string]string{"cron": "* * * * * *", "timezone": "UTC"})
	if status != 422 {
		t.Fatal("six-field Cron accepted", status)
	}
	c.WebDAV.Password = ""
	status, body = s.do("POST", "/api/v1/admin/backups/test", token, c)
	if status != 200 {
		t.Fatalf("test retained credentials %d %+v", status, body.Error)
	}
	status, body = s.do("POST", "/api/v1/admin/backups/run", token, nil)
	if status != 201 {
		t.Fatalf("run %d %+v", status, body.Error)
	}
	s.backups.Wait()
	state := s.backups.State()
	if state.Current.Status != "succeeded" {
		t.Fatal(state.Current)
	}
	// Changes after the archive must be undone by restoration, including settings caches.
	status, _ = s.do("PUT", "/api/v1/admin/settings", token, map[string]any{"site.name": "Changed after backup"})
	if status != 200 {
		t.Fatal(status)
	}
	mu.Lock()
	raw := string(archive)
	mu.Unlock()
	req, _ := http.NewRequest("POST", s.server.URL+"/api/v1/admin/backups/restore/preview", strings.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/zip")
	response, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("preview %d %s", response.StatusCode, raw)
	}
	// Use the manager preview token while the HTTP upload above verifies raw ZIP transport.
	preview, err := s.backups.Inspect(t.Context(), "unused-owner", strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	status, _ = s.do("POST", "/api/v1/admin/backups/restore", token, map[string]any{"id": preview.ID, "confirm": true})
	if status != 409 {
		t.Fatal("foreign token accepted", status)
	}
	// Decode the actual HTTP preview response and restore through its owner.
	var envelope struct {
		Data backup.RestorePreview `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	status, _ = s.do("POST", "/api/v1/admin/backups/restore", token, map[string]any{"id": envelope.Data.ID, "confirm": false})
	if status != 400 {
		t.Fatal("missing confirmation accepted", status)
	}
	status, body = s.do("POST", "/api/v1/admin/backups/restore", token, map[string]any{"id": envelope.Data.ID, "confirm": true})
	if status != 201 {
		t.Fatalf("restore %d %+v", status, body.Error)
	}
	s.backups.Wait()
	if job := s.backups.State().Current; job.Status != "succeeded" {
		t.Fatal(job)
	}
	status, _ = s.do("GET", "/api/v1/auth/me", token, nil)
	if status != 401 {
		t.Fatal("old token survived", status)
	}
	status, body = s.do("GET", "/api/v1/site/config", "", nil)
	if status != 200 || body.Data["siteName"] != "wmind" {
		t.Fatalf("settings cache not restored %d %+v", status, body)
	}
}

func TestBackupDedupAfterRealLoginMapReadAndAnonymousShareView(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)
	uid := s.createMap(token, "只读去重测试")
	share := s.createShare(token, uid, map[string]any{})
	var mu sync.Mutex
	uploads := 0
	dav := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "PROPFIND":
			w.WriteHeader(207)
		case "PUT":
			mu.Lock()
			uploads++
			mu.Unlock()
			w.WriteHeader(201)
		case "HEAD":
			w.WriteHeader(200)
		case "DELETE":
			w.WriteHeader(204)
		default:
			w.WriteHeader(405)
		}
	}))
	defer dav.Close()
	c := backup.DefaultConfiguration()
	c.SkipUnchanged = true
	c.WebDAV.URL = dav.URL
	if err := s.backups.Save(t.Context(), c, nil); err != nil {
		t.Fatal(err)
	}
	run := func() backup.Job {
		t.Helper()
		status, body := s.do("POST", "/api/v1/admin/backups/run", token, nil)
		if status != 201 {
			t.Fatal(status, body.Error)
		}
		s.backups.Wait()
		return *s.backups.State().Current
	}
	first := run()
	if first.Status != "succeeded" {
		t.Fatal(first)
	}
	token = s.loginAs(testAdminEmail, testAdminPassword)
	for _, read := range []struct{ path, token string }{{"/api/v1/maps/" + uid, token}, {"/api/v1/public/shares/" + share["token"].(string), ""}} {
		status, body := s.do("GET", read.path, read.token, nil)
		if status != 200 {
			t.Fatal(read.path, status, body.Error)
		}
	}
	if job := run(); job.Status != "skipped" || job.ContentVersion != first.ContentVersion {
		t.Fatal("real reads triggered backup", job)
	}
	mu.Lock()
	count := uploads
	mu.Unlock()
	if count != 1 {
		t.Fatal("duplicate remote object", count)
	}
	status, body := s.do("PATCH", "/api/v1/shares/"+share["uid"].(string), token, map[string]any{"allowDownload": false})
	if status != 200 {
		t.Fatal(status, body.Error)
	}
	if job := run(); job.Status != "succeeded" || job.ContentVersion == first.ContentVersion {
		t.Fatal("share configuration change ignored", job)
	}
}
func TestMaintenanceRejectsBusinessRequestsButKeepsLiveness(t *testing.T) {
	s := newAuthTestServer(t)
	resume := s.backups.Gate().Pause()
	defer resume()
	status, _ := s.do("GET", "/api/v1/site/config", "", nil)
	if status != 503 {
		t.Fatal(status)
	}
	status, _ = s.do("GET", "/api/v1/health/live", "", nil)
	if status != 200 {
		t.Fatal(status)
	}
}
