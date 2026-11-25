package remoteproxy

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
)

func TestProxyUsesNativeHeaderAndAdoptsSessionReplacement(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Wmind-Client") != "desktop" || r.Header.Get("Cookie") != "" {
			t.Error("proxy did not select native credential mode")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":{"accessToken":"new-access","refreshToken":"new-refresh","refreshExpiresAt":"2030-01-01T00:00:00Z","user":{"uid":"u"}}}`)
	}))
	defer upstream.Close()
	client, err := cloud.New(upstream.URL, cloud.Session{AccessToken: "old-access", RefreshToken: "old-refresh"})
	if err != nil {
		t.Fatal(err)
	}
	saved := ""
	client.SetSessionSaver(func(s cloud.Session) error { saved = s.RefreshToken; return nil })
	proxy, err := Handler(client, upstream.URL, Prefix, "/api/v1", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, Prefix+"users/me/password", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || client.Session().AccessToken != "new-access" || client.Session().RefreshToken != "new-refresh" || saved != "new-refresh" {
		t.Fatalf("session replacement not adopted: status=%d session=%+v saved=%q", rec.Code, client.Session(), saved)
	}
	if strings.Contains(rec.Body.String(), "new-refresh") || strings.Contains(rec.Body.String(), "refreshExpiresAt") {
		t.Fatalf("native session credentials leaked to WebView: %s", rec.Body.String())
	}
}
