package main

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/cloudcreds"
	"github.com/woliubang256/wmind/backend/desktop/internal/credstore"
	"github.com/woliubang256/wmind/backend/desktop/internal/deskapi"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncengine"
)

const restoreTestSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func openRestoreStore(t *testing.T, path string) (*deskapi.CredentialStore, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := credstore.Prepare(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	return &deskapi.CredentialStore{Repo: credstore.New(db, restoreTestSecret)}, db
}

func TestSavedNativeSessionRestoresFromDatabaseAfterTwoRestarts(t *testing.T) {
	client, _, cleanup := newCloudServer(t)
	defer cleanup()
	path := filepath.Join(t.TempDir(), "session.db")
	creds, db := openRestoreStore(t, path)
	if err := creds.Attach(client, harnessEmail); err != nil {
		t.Fatal(err)
	}
	prior := client.Session().RefreshToken
	for range 2 {
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		creds, db = openRestoreStore(t, path)
		engine := syncengine.New(nil, nil, 1, testLogger())
		restoreCloud(engine, creds, testLogger())
		if !engine.Connected() || engine.Client().Session().AccessToken != "" {
			t.Fatal("startup must restore only the refresh credential")
		}
		if _, err := engine.Client().Me(t.Context()); err != nil {
			t.Fatalf("restored session unusable: %v", err)
		}
		stored, err := creds.Load()
		if err != nil || stored.RefreshToken == "" || stored.RefreshToken == prior {
			t.Fatal("rotated refresh was not persisted")
		}
		prior = stored.RefreshToken
		var raw string
		if err := db.QueryRow(`SELECT value FROM desktop_secrets`).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(raw, prior) || strings.Contains(raw, harnessPassword) || strings.Contains(raw, `"accessToken"`) || strings.Contains(raw, `"password"`) {
			t.Fatal("readable credentials were persisted")
		}
	}
}

func TestRestoreLegacyPasswordOnlyRecordRequiresInteractiveLogin(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.WriteHeader(500) }))
	defer server.Close()
	creds, db := openRestoreStore(t, filepath.Join(t.TempDir(), "session.db"))
	raw := `{"serverUrl":"` + server.URL + `","identifier":"legacy","password":"old-encrypted-password"}`
	if _, err := db.Exec(`INSERT INTO desktop_secrets(key,value,updated_at) VALUES('cloud-connection',?,datetime('now'))`, raw); err != nil {
		t.Fatal(err)
	}
	engine := syncengine.New(nil, nil, 1, testLogger())
	restoreCloud(engine, creds, testLogger())
	if engine.Connected() || requests.Load() != 0 {
		t.Fatal("legacy password must not be used to log in automatically")
	}
	if err := db.QueryRow(`SELECT value FROM desktop_secrets`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "password") {
		t.Fatal("legacy password was retained")
	}
	stored, err := creds.Load()
	if err != nil || stored.Identifier != "legacy" {
		t.Fatal("legacy account prefill was lost")
	}
}

func TestRestoredNativeSessionSurvivesOfflineAndRejectsRevocation(t *testing.T) {
	var state atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if state.Load() == 0 {
			w.WriteHeader(503)
			return
		}
		if state.Load() == 2 {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/v1/auth/refresh" {
			_, _ = w.Write([]byte(`{"data":{"accessToken":"fresh","refreshToken":"next"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"uid":"owner","email":"owner@example.test"}}`))
	}))
	defer server.Close()
	creds, _ := openRestoreStore(t, filepath.Join(t.TempDir(), "session.db"))
	if err := creds.Save(cloudcreds.Credentials{ServerURL: server.URL, Identifier: "owner", RefreshToken: "keep"}); err != nil {
		t.Fatal(err)
	}
	engine := syncengine.New(nil, nil, 1, testLogger())
	restoreCloud(engine, creds, testLogger())
	if _, err := engine.Client().Me(t.Context()); !errors.Is(err, cloud.ErrUnavailable) {
		t.Fatalf("offline error = %v", err)
	}
	stored, _ := creds.Load()
	if !engine.Connected() || stored.RefreshToken != "keep" {
		t.Fatal("offline startup erased the session")
	}
	state.Store(1)
	if _, err := engine.Client().Me(t.Context()); err != nil {
		t.Fatalf("network recovery: %v", err)
	}
	state.Store(2)
	if _, err := engine.Client().Me(t.Context()); !errors.Is(err, cloud.ErrUnauthorized) {
		t.Fatalf("revocation = %v", err)
	}
	stored, _ = creds.Load()
	if engine.Connected() || stored.RefreshToken != "" {
		t.Fatal("revoked session was not invalidated")
	}
}
