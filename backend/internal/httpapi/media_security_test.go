package httpapi_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/handler"
)

func (s *authTestServer) mediaRequest(method, path, bearer, cookie string) (int, string, http.Header) {
	s.t.Helper()
	req, err := http.NewRequest(method, s.server.URL+path, nil)
	if err != nil {
		s.t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: handler.MediaCookieName, Value: cookie})
	}
	req.Header.Set("Range", "bytes=0-15")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), resp.Header
}

func (s *authTestServer) mediaCookie() string {
	s.t.Helper()
	u, _ := url.Parse(s.server.URL + "/uploads/file.png")
	for _, cookie := range s.client.Jar.Cookies(u) {
		if cookie.Name == handler.MediaCookieName {
			return cookie.Value
		}
	}
	s.t.Fatal("missing media cookie")
	return ""
}

func docWithImage(path string) map[string]any {
	doc := mapDoc("private picture")
	root := doc["sheets"].([]any)[0].(map[string]any)["rootTopic"].(map[string]any)
	root["image"] = map[string]any{"src": path, "width": 4, "height": 4}
	return doc
}

func TestMediaPrivateFilesRejectAnonymousAndOtherOwners(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("mediaowner")
	status, uploaded := s.uploadFile(owner, "file", "a.png", "image/png", pngBytes(t, 4, 4))
	if status != http.StatusOK {
		t.Fatalf("upload = %d", status)
	}
	path := uploaded.Data["url"].(string)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req, _ := http.NewRequest(method, s.server.URL+path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("anonymous %s = %d; want 404", method, resp.StatusCode)
		}
	}
	other := s.registerUser("mediaother")
	req, _ := http.NewRequest(http.MethodGet, s.server.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+other)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("other owner = %d; want 404", resp.StatusCode)
	}
	doc := mapDoc("copied")
	root := doc["sheets"].([]any)[0].(map[string]any)["rootTopic"].(map[string]any)
	root["image"] = map[string]any{"src": path}
	status, _ = s.do(http.MethodPost, "/api/v1/maps", other, map[string]any{"document": doc})
	if status < 400 {
		t.Errorf("copy foreign image into own map = %d; want rejection", status)
	}
}

func TestMediaSessionRevocationAndIssuerIsolation(t *testing.T) {
	for _, action := range []string{"logout", "refresh", "password", "disable", "delete"} {
		t.Run(action, func(t *testing.T) {
			s := newAuthTestServer(t)
			owner := s.registerUser("mediasession")
			cookie := s.mediaCookie()
			_, uploaded := s.uploadFile(owner, "file", "a.png", "image/png", pngBytes(t, 4, 4))
			path := uploaded.Data["url"].(string)
			if status, _, _ := s.mediaRequest("GET", path, "", cookie); status != http.StatusPartialContent {
				t.Fatalf("owner cookie = %d", status)
			}
			if status, _ := s.do("GET", "/api/v1/auth/me", cookie, nil); status != http.StatusUnauthorized {
				t.Errorf("media as API token = %d", status)
			}
			if status, _, _ := s.mediaRequest("GET", path, "", owner); status != http.StatusNotFound {
				t.Errorf("API token as media = %d", status)
			}
			request, _ := http.NewRequest("POST", s.server.URL+"/api/v1/auth/refresh", strings.NewReader(`{"refreshToken":"`+cookie+`"}`))
			request.Header.Set("Content-Type", "application/json")
			result, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			result.Body.Close()
			if result.StatusCode != http.StatusUnauthorized {
				t.Errorf("media as refresh token = %d", result.StatusCode)
			}
			if action == "disable" || action == "delete" {
				_, profile := s.do("GET", "/api/v1/auth/me", owner, nil)
				admin := s.loginAs(testAdminEmail, testAdminPassword)
				adminPath := "/api/v1/admin/users/" + profile.Data["uid"].(string)
				if action == "disable" {
					s.do("PATCH", adminPath, admin, map[string]string{"status": "disabled"})
				} else {
					s.do("DELETE", adminPath, admin, nil)
				}
			} else if action == "password" {
				status, _ := s.do("POST", "/api/v1/users/me/password", owner, map[string]string{"oldPassword": "correct-horse", "newPassword": "new-correct-horse"})
				if status != http.StatusOK {
					t.Fatalf("change password = %d", status)
				}
				if status, _, _ := s.mediaRequest("GET", path, "", s.mediaCookie()); status != http.StatusPartialContent {
					t.Errorf("replacement media = %d", status)
				}
			} else if action == "logout" {
				s.do("POST", "/api/v1/auth/logout", "", nil)
			} else {
				s.do("POST", "/api/v1/auth/refresh", "", nil)
			}
			for _, method := range []string{"GET", "HEAD"} {
				status, _, headers := s.mediaRequest(method, path, "", cookie)
				if status != http.StatusNotFound || headers.Get("Cache-Control") != "no-store" {
					t.Errorf("revoked %s = %d, cache %q", method, status, headers.Get("Cache-Control"))
				}
			}
		})
	}
}

func TestMediaLegacyReferencesAndWriteBoundaries(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("legacyowner")
	legacy := "/uploads/file_0123456789abcdef0123456789abcdef.png"
	uid := s.createMap(owner, "legacy")
	raw, _ := json.Marshal(docWithImage(legacy))
	if _, err := s.db.Exec("UPDATE maps SET document = ?, thumbnail_url = ? WHERE uid = ?", string(raw), legacy, uid); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.uploads, strings.TrimPrefix(legacy, "/uploads/")), pngBytes(t, 4, 4), 0600); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := s.mediaRequest("GET", legacy, owner, ""); status != http.StatusPartialContent {
		t.Fatalf("legacy owner = %d", status)
	}
	status, duplicate := s.do("POST", "/api/v1/maps/"+uid+"/duplicate", owner, nil)
	if status != http.StatusCreated {
		t.Fatalf("duplicate legacy = %d", status)
	}
	if status, _ := s.do("POST", "/api/v1/templates", owner, map[string]string{"mapUid": uid, "name": "legacy template"}); status != http.StatusCreated {
		t.Fatalf("template = %d", status)
	}
	if status, _ := s.do("DELETE", "/api/v1/maps/"+uid, owner, nil); status != http.StatusNoContent {
		t.Fatal(status)
	}
	if status, _, _ := s.mediaRequest("GET", legacy, owner, ""); status != http.StatusPartialContent {
		t.Errorf("legacy trash/template = %d", status)
	}
	s.do("DELETE", "/api/v1/trash/"+uid, owner, nil)
	duplicateUID := duplicate.Data["uid"].(string)
	s.do("DELETE", "/api/v1/maps/"+duplicateUID, owner, nil)
	s.do("DELETE", "/api/v1/trash/"+duplicateUID, owner, nil)
	if status, _, _ := s.mediaRequest("GET", legacy, owner, ""); status != http.StatusPartialContent {
		t.Errorf("template-only legacy = %d", status)
	}
	other := s.registerUser("legacyother")
	otherUID := s.createMap(other, "other")
	for _, path := range []string{legacy, legacy + "?share=anything", legacy + "#ignored"} {
		status, _ := s.do("POST", "/api/v1/maps", other, map[string]any{"document": docWithImage(path)})
		if status != http.StatusUnprocessableEntity {
			t.Errorf("create with foreign %s = %d", path, status)
		}
		status, _ = s.do("PUT", "/api/v1/maps/"+otherUID, other, map[string]any{"version": 1, "document": docWithImage(path)})
		if status != http.StatusUnprocessableEntity {
			t.Errorf("save foreign = %d", status)
		}
		status, _ = s.do("PUT", "/api/v1/maps/"+otherUID+"/thumbnail", other, map[string]string{"thumbnailUrl": path})
		if status != http.StatusUnprocessableEntity {
			t.Errorf("foreign thumbnail = %d", status)
		}
	}
	if status, _, _ := s.mediaRequest("GET", legacy, other, ""); status != http.StatusNotFound {
		t.Errorf("foreign legacy after injection = %d", status)
	}
	// A bare mention in notes/unknown fields cannot create a legacy grant.
	unreferenced := "/uploads/file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"
	doc := mapDocWithNotes("mentioned", unreferenced)
	s.do("POST", "/api/v1/maps", other, map[string]any{"document": doc})
	if err := os.WriteFile(filepath.Join(s.uploads, strings.TrimPrefix(unreferenced, "/uploads/")), pngBytes(t, 4, 4), 0600); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := s.mediaRequest("GET", unreferenced, other, ""); status != http.StatusNotFound {
		t.Errorf("notes reference granted access = %d", status)
	}
}

func TestMediaSharesRecheckCurrentAccessAndOnlyRewriteLocalImages(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("mediashare")
	_, upload := s.uploadFile(owner, "file", "a.png", "image/png", pngBytes(t, 4, 4))
	path := upload.Data["url"].(string)
	doc := docWithImage(path)
	doc["sheets"].([]any)[0].(map[string]any)["floatingTopics"] = []any{map[string]any{"id": "remote", "image": map[string]string{"src": "https://external.invalid/a.png"}}}
	status, created := s.do("POST", "/api/v1/maps", owner, map[string]any{"document": doc})
	if status != http.StatusCreated {
		t.Fatal(status)
	}
	mapUID := created.Data["uid"].(string)
	link := s.createShare(owner, mapUID, map[string]any{"password": "Ab4x"})
	public := "/api/v1/public/shares/" + link["token"].(string)
	_, verified := s.do("POST", public+"/verify", "", map[string]string{"password": "Ab4x"})
	access := verified.Data["accessToken"].(string)
	_, payload := s.doHeader("GET", public, "", nil, map[string]string{"X-Share-Access": access})
	responseDoc := payload.Data["document"].(map[string]any)
	sheet := responseDoc["sheets"].([]any)[0].(map[string]any)
	signedPath := sheet["rootTopic"].(map[string]any)["image"].(map[string]any)["src"].(string)
	if !strings.Contains(signedPath, "share=") || !strings.Contains(signedPath, "access=") {
		t.Fatalf("missing image authorization: %q", signedPath)
	}
	if src := sheet["floatingTopics"].([]any)[0].(map[string]any)["image"].(map[string]any)["src"]; src != "https://external.invalid/a.png" {
		t.Errorf("external token leak: %v", src)
	}
	if status, _, _ := s.mediaRequest("GET", signedPath, "", ""); status != http.StatusPartialContent {
		t.Errorf("authorized share image = %d", status)
	}
	if status, _, _ := s.mediaRequest("GET", path+"?share="+link["token"].(string), "", ""); status != http.StatusNotFound {
		t.Errorf("missing password proof = %d", status)
	}
	_, otherUpload := s.uploadFile(owner, "file", "b.png", "image/png", pngBytes(t, 4, 4))
	otherPath := otherUpload.Data["url"].(string) + strings.TrimPrefix(signedPath, path)
	if status, _, _ := s.mediaRequest("GET", otherPath, "", ""); status != http.StatusNotFound {
		t.Errorf("unreferenced share image = %d", status)
	}
	_, original := s.do("GET", "/api/v1/maps/"+mapUID, owner, nil)
	stored, _ := json.Marshal(original.Data["document"])
	if strings.Contains(string(stored), "?share=") {
		t.Fatal("transient credentials persisted")
	}
	s.do("PATCH", "/api/v1/shares/"+link["uid"].(string), owner, map[string]string{"password": "Xy9z"})
	if status, _, _ := s.mediaRequest("GET", signedPath, "", ""); status != http.StatusNotFound {
		t.Errorf("old image proof after password reset = %d", status)
	}
	_, verified = s.do("POST", public+"/verify", "", map[string]string{"password": "Xy9z"})
	u, _ := url.Parse(signedPath)
	q := u.Query()
	q.Set("access", verified.Data["accessToken"].(string))
	u.RawQuery = q.Encode()
	if status, _, _ := s.mediaRequest("GET", u.String(), "", ""); status != http.StatusPartialContent {
		t.Errorf("new proof = %d", status)
	}
	status, _ = s.do("PUT", "/api/v1/maps/"+mapUID, owner, map[string]any{"version": 1, "document": mapDoc("removed image")})
	if status != http.StatusOK {
		t.Fatalf("remove image = %d", status)
	}
	if status, _, _ := s.mediaRequest("GET", u.String(), "", ""); status != http.StatusNotFound {
		t.Errorf("no longer referenced share image = %d", status)
	}
	status, _ = s.do("PUT", "/api/v1/maps/"+mapUID, owner, map[string]any{"version": 2, "document": doc})
	if status != http.StatusOK {
		t.Fatalf("restore image = %d", status)
	}
	s.do("DELETE", "/api/v1/shares/"+link["uid"].(string), owner, nil)
	if status, _, _ := s.mediaRequest("GET", u.String(), "", ""); status != http.StatusNotFound {
		t.Errorf("revoked share = %d", status)
	}
}

func TestMediaPublicAvatarsAndFilesystemBoundary(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("mediaavatar")
	status, uploaded := s.upload("/api/v1/users/me/avatar", owner, "a.png", pngBytes(t, 4, 4))
	if status != http.StatusOK {
		t.Fatal(status)
	}
	path := uploaded.Data["avatarUrl"].(string)
	if status, _, _ := s.mediaRequest("GET", path, "", ""); status != http.StatusPartialContent {
		t.Errorf("public avatar = %d", status)
	}
	for _, path := range []string{"/uploads/", "/uploads/.env", "/uploads/random.txt", "/uploads/avatar_anything.png", "/uploads/../.env"} {
		if status, _, _ := s.mediaRequest("GET", path, "", ""); status != http.StatusNotFound {
			t.Errorf("unsafe path %s = %d", path, status)
		}
	}
	_, uploaded = s.uploadFile(owner, "file", "a.png", "image/png", pngBytes(t, 4, 4))
	path = uploaded.Data["url"].(string)
	key := filepath.Join(s.uploads, strings.TrimPrefix(path, "/uploads/"))
	if err := os.Remove(key); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../outside", key); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := s.mediaRequest("GET", path, owner, ""); status != http.StatusNotFound {
		t.Errorf("symlink = %d", status)
	}
}

func TestMediaShareLifecycleAndHiddenReferences(t *testing.T) {
	for _, action := range []string{"expire", "delete-map", "disable-owner", "delete-owner", "hidden-note"} {
		t.Run(action, func(t *testing.T) {
			s := newAuthTestServer(t)
			owner := s.registerUser("medialifecycle")
			_, profile := s.do("GET", "/api/v1/auth/me", owner, nil)
			_, uploaded := s.uploadFile(owner, "file", "a.png", "image/png", pngBytes(t, 4, 4))
			path := uploaded.Data["url"].(string)
			doc := docWithImage(path)
			_, hidden := s.uploadFile(owner, "file", "b.png", "image/png", pngBytes(t, 4, 4))
			hiddenPath := hidden.Data["url"].(string)
			doc["sheets"].([]any)[0].(map[string]any)["rootTopic"].(map[string]any)["notes"] = map[string]any{"image": map[string]string{"src": hiddenPath}}
			status, created := s.do("POST", "/api/v1/maps", owner, map[string]any{"document": doc})
			if status != http.StatusCreated {
				t.Fatal(status)
			}
			uid := created.Data["uid"].(string)
			link := s.createShare(owner, uid, map[string]any{"showNotes": false})
			suffix := "?share=" + link["token"].(string)
			if status, _, _ := s.mediaRequest("GET", path+suffix, "", ""); status != http.StatusPartialContent {
				t.Fatalf("plain shared image = %d", status)
			}
			switch action {
			case "expire":
				if _, err := s.db.Exec("UPDATE share_links SET expires_at = ? WHERE uid = ?", "2000-01-01T00:00:00Z", link["uid"]); err != nil {
					t.Fatal(err)
				}
			case "delete-map":
				s.do("DELETE", "/api/v1/maps/"+uid, owner, nil)
			case "disable-owner", "delete-owner":
				admin := s.loginAs(testAdminEmail, testAdminPassword)
				adminPath := "/api/v1/admin/users/" + profile.Data["uid"].(string)
				if action == "disable-owner" {
					s.do("PATCH", adminPath, admin, map[string]string{"status": "disabled"})
				} else {
					s.do("DELETE", adminPath, admin, nil)
				}
			case "hidden-note":
				path = hiddenPath
			}
			if status, _, _ := s.mediaRequest("GET", path+suffix, "", ""); status != http.StatusNotFound {
				t.Errorf("%s shared image = %d", action, status)
			}
		})
	}
}
