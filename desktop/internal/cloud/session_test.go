package cloud

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeRefreshUsesJSONAndNeverSendsCookies(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			RefreshToken string `json:"refreshToken"`
		}
		if r.Header.Get("X-Wmind-Client") != "desktop" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || json.NewDecoder(r.Body).Decode(&body) != nil || body.RefreshToken != "refresh-1" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = fmt.Fprint(w, `{"data":{"accessToken":"fresh","refreshToken":"refresh-2"}}`)
	}))
	defer server.Close()
	client, _ := New(server.URL, Session{RefreshToken: "refresh-1"})
	if err := client.Refresh(t.Context()); err != nil {
		t.Fatalf("native refresh: %v", err)
	}
	if calls.Load() != 1 || client.Session().RefreshToken != "refresh-2" {
		t.Fatal("refresh did not rotate")
	}
}

func TestConcurrentUnauthorizedRequestsShareOneRefresh(t *testing.T) {
	const requests = 8
	arrived := make(chan struct{}, requests)
	release := make(chan struct{})
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/refresh" {
			refreshes.Add(1)
			_, _ = fmt.Fprint(w, `{"data":{"accessToken":"fresh","refreshToken":"next"}}`)
			return
		}
		if r.Header.Get("Authorization") == "Bearer stale" {
			arrived <- struct{}{}
			<-release
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = fmt.Fprint(w, `{"data":[]}`)
	}))
	defer server.Close()
	client, _ := New(server.URL, Session{AccessToken: "stale", RefreshToken: "old"})
	errorsCh := make(chan error, requests)
	for range requests {
		go func() { _, err := client.ListChanged(t.Context(), time.Now()); errorsCh <- err }()
	}
	for range requests {
		<-arrived
	}
	close(release)
	for range requests {
		if err := <-errorsCh; err != nil {
			t.Errorf("request failed: %v", err)
		}
	}
	if refreshes.Load() != 1 {
		t.Fatalf("refreshes = %d, want 1", refreshes.Load())
	}
}

func TestTransientRefreshFailureIsNotUnauthorized(t *testing.T) {
	for _, status := range []int{403, 429, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/auth/refresh" {
					w.WriteHeader(status)
					return
				}
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer server.Close()
			client, _ := New(server.URL, Session{AccessToken: "old", RefreshToken: "keep"})
			_, err := client.ListChanged(t.Context(), time.Now())
			if !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrUnauthorized) {
				t.Fatalf("transient error was treated as logout: %v", err)
			}
			if client.Session().RefreshToken != "keep" {
				t.Fatal("transient error erased refresh token")
			}
		})
	}
}

func TestRefreshRejectsIncompleteSuccessfulResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, `{"data":{"accessToken":"incomplete"}}`)
	}))
	defer server.Close()
	client, _ := New(server.URL, Session{RefreshToken: "keep"})
	if err := client.Refresh(t.Context()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("incomplete response: %v", err)
	}
	if client.Session().RefreshToken != "keep" {
		t.Fatal("invalid response damaged session")
	}
}

func TestRotationRetriesPersistenceWithoutReplayingOldRefresh(t *testing.T) {
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/refresh" {
			refreshes.Add(1)
			_, _ = fmt.Fprint(w, `{"data":{"accessToken":"fresh","refreshToken":"rotated"}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"data":[]}`)
	}))
	defer server.Close()
	client, _ := New(server.URL, Session{RefreshToken: "old"})
	var saves int
	client.SetSessionSaver(func(session Session) error {
		saves++
		if session.RefreshToken != "rotated" {
			t.Fatal("persisted wrong refresh")
		}
		if saves == 1 {
			return errors.New("database temporarily unavailable")
		}
		return nil
	})
	if _, err := client.ListChanged(t.Context(), time.Now()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("save failure = %v", err)
	}
	if _, err := client.ListChanged(t.Context(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if saves != 2 || refreshes.Load() != 1 {
		t.Fatalf("saves=%d refreshes=%d", saves, refreshes.Load())
	}
}
