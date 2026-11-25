package deskapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
)

func TestLateRotationCannotRestoreSignedOutOrReplacedCredentials(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "logout", true: "switch-account"}[replace], func(t *testing.T) {
			f := newFixture(t)
			arrived, release := make(chan struct{}), make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(arrived)
				<-release
				_, _ = w.Write([]byte(`{"data":{"accessToken":"fresh-old-account","refreshToken":"rotated-old-account"}}`))
			}))
			defer server.Close()
			client, _ := cloud.New(server.URL, cloud.Session{RefreshToken: "old-account"})
			if err := f.creds.Attach(client, "old"); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- client.Refresh(t.Context()) }()
			<-arrived
			if replace {
				newClient, _ := cloud.New(server.URL, cloud.Session{AccessToken: "current-access", RefreshToken: "current-refresh"})
				if err := f.creds.Attach(newClient, "current"); err != nil {
					t.Fatal(err)
				}
			} else if err := f.creds.Clear(); err != nil {
				t.Fatal(err)
			}
			close(release)
			if err := <-done; !errors.Is(err, cloud.ErrUnavailable) {
				t.Fatalf("late persistence should be refused: %v", err)
			}
			stored, err := f.creds.Load()
			if err != nil {
				t.Fatal(err)
			}
			if replace {
				if stored == nil || stored.Identifier != "current" || stored.RefreshToken != "current-refresh" {
					t.Fatal("late rotation overwrote the current account")
				}
			} else if stored != nil {
				t.Fatal("late rotation recreated signed-out credentials")
			}
		})
	}
}
