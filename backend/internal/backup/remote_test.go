package backup

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWebDAVCreatesDirectoryTestsAndUploads(t *testing.T) {
	folders := map[string]bool{"/dav": true}
	objects := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "test-user" || password != "test-secret" {
			w.WriteHeader(401)
			return
		}
		switch r.Method {
		case "PROPFIND":
			if folders[strings.TrimRight(r.URL.Path, "/")] {
				w.WriteHeader(207)
			} else {
				w.WriteHeader(404)
			}
		case "MKCOL":
			folders[r.URL.Path] = true
			w.WriteHeader(201)
		case "PUT":
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = string(b)
			w.WriteHeader(201)
		case "DELETE":
			delete(objects, r.URL.Path)
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected method %s", r.Method)
			w.WriteHeader(405)
		}
	}))
	defer server.Close()
	c := DefaultConfiguration()
	c.Target = "webdav"
	c.WebDAV = WebDAVConfig{URL: server.URL + "/dav/备份", Username: "test-user", Password: "test-secret"}
	remote := NewRemoteStorage()
	if err := remote.Test(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	if len(objects) != 0 || !folders["/dav/备份"] {
		t.Fatal("test did not clean up or create folder", objects, folders)
	}
	filename := filepath.Join(t.TempDir(), "backup.zip")
	os.WriteFile(filename, []byte("zip content"), 0600)
	if err := remote.Upload(t.Context(), c, "wmind-test.zip", filename); err != nil {
		t.Fatal(err)
	}
	if objects["/dav/备份/wmind-test.zip"] != "zip content" {
		t.Fatal(objects)
	}
	c.WebDAV.Password = "wrong-secret"
	if err := remote.Test(t.Context(), c); err == nil || strings.Contains(err.Error(), "wrong-secret") {
		t.Fatal("unsafe failure", err)
	}
}
func TestS3CompatibleSignedUploadAndConnectionCleanup(t *testing.T) {
	objects := map[string]string{}
	signed := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=test-access/") {
			t.Error("request not signed", r.Header.Get("Authorization"))
			w.WriteHeader(403)
			return
		}
		signed++
		switch r.Method {
		case "PUT":
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = string(b)
			w.Header().Set("ETag", `"etag"`)
			w.WriteHeader(200)
		case "DELETE":
			delete(objects, r.URL.Path)
			w.WriteHeader(204)
		default:
			t.Error(r.Method)
			w.WriteHeader(405)
		}
	}))
	defer server.Close()
	c := DefaultConfiguration()
	c.Target = "s3"
	c.S3.Endpoint = server.URL
	c.S3.Bucket = "backups"
	c.S3.AccessKey = "test-access"
	c.S3.SecretKey = "test-secret"
	remote := NewRemoteStorage()
	if err := remote.Test(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	if len(objects) != 0 || signed != 2 {
		t.Fatal("connection test did not clean up", objects, signed)
	}
	filename := filepath.Join(t.TempDir(), "snapshot.zip")
	os.WriteFile(filename, []byte("zip content"), 0600)
	if err := remote.Upload(t.Context(), c, "wmind-test.zip", filename); err != nil {
		t.Fatal(err)
	}
	if objects["/backups/wmind/wmind-test.zip"] != "zip content" {
		t.Fatal(objects)
	}
}
func TestRemoteRefusesRedirectsAndDoesNotLeakCredentials(t *testing.T) {
	reached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	c := DefaultConfiguration()
	c.Target = "webdav"
	c.WebDAV = WebDAVConfig{URL: redirect.URL, Username: "private-user", Password: "private-password"}
	err := NewRemoteStorage().Test(t.Context(), c)
	if err == nil || reached || strings.Contains(err.Error(), "private-password") {
		t.Fatal(reached, err)
	}
	name := "wmind-20261024T030000Z-ABCDEFGH.zip"
	if _, err := NewRemoteStorage().Exists(t.Context(), c, name); err == nil || reached {
		t.Fatal("HEAD followed redirect")
	}
	if err := NewRemoteStorage().Delete(t.Context(), c, name); err == nil || reached {
		t.Fatal("DELETE followed redirect")
	}
}

func TestRemoteObjectChecksAndExactDeletion(t *testing.T) {
	const name = "wmind-20261024T030000Z-ABCDEFGH.zip"
	for _, protocol := range []string{"webdav", "s3"} {
		t.Run(protocol, func(t *testing.T) {
			exists, requests := true, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path != "/backups/"+name {
					t.Errorf("wrong object: %s", r.URL.Path)
				}
				if protocol == "webdav" {
					user, password, ok := r.BasicAuth()
					if !ok || user != "user" || password != "secret" {
						t.Error("missing DAV auth")
					}
				} else if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=access/") {
					t.Error("missing S3 signature")
				}
				if !exists {
					w.WriteHeader(404)
					return
				}
				switch r.Method {
				case "HEAD":
					w.WriteHeader(200)
				case "DELETE":
					exists = false
					w.WriteHeader(204)
				default:
					t.Error(r.Method)
					w.WriteHeader(405)
				}
			}))
			defer server.Close()
			c := DefaultConfiguration()
			c.Target = protocol
			c.WebDAV = WebDAVConfig{URL: server.URL + "/backups", Username: "user", Password: "secret"}
			c.S3 = S3Config{Endpoint: server.URL, Region: "us-east-1", Bucket: "backups", AccessKey: "access", SecretKey: "secret", PathStyle: true}
			r := NewRemoteStorage()
			if ok, err := r.Exists(t.Context(), c, name); err != nil || !ok {
				t.Fatal(ok, err)
			}
			if err := r.Delete(t.Context(), c, name); err != nil {
				t.Fatal(err)
			}
			if ok, err := r.Exists(t.Context(), c, name); err != nil || ok {
				t.Fatal(ok, err)
			}
			if err := r.Delete(t.Context(), c, name); err != nil {
				t.Fatal("404 must be idempotent", err)
			}
			for _, invalid := range []string{"../" + name, "other.zip", name + "/child", "before-restore-20261024.zip"} {
				if err := r.Delete(t.Context(), c, invalid); err == nil {
					t.Fatal("unsafe deletion accepted", invalid)
				}
				if _, err := r.Exists(t.Context(), c, invalid); err == nil {
					t.Fatal("unsafe check accepted", invalid)
				}
			}
			if requests != 4 {
				t.Fatal("unsafe names reached remote", requests)
			}
		})
	}
}
