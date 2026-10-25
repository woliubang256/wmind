package httpapi_test

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/handler"
)

func TestPasswordChangeRevokesAccessAndRetainsBrowserSession(t *testing.T) {
	s := newAuthTestServer(t)
	current := s.registerUser("passwordsession")
	other := s.loginAs("passwordsession", "correct-horse")
	mediaURL, _ := url.Parse(s.server.URL + "/uploads/private.png")
	mediaCookie := func() string {
		for _, cookie := range s.client.Jar.Cookies(mediaURL) {
			if cookie.Name == handler.MediaCookieName {
				return cookie.Value
			}
		}
		return ""
	}
	priorMedia := mediaCookie()
	status, changed := s.do(http.MethodPost, "/api/v1/users/me/password", current, map[string]string{
		"oldPassword": "correct-horse", "newPassword": "new-correct-horse",
	})
	if oldStatus, _ := s.do(http.MethodGet, "/api/v1/auth/me", other, nil); oldStatus != http.StatusUnauthorized {
		t.Errorf("other device access after password change = %d, want 401", oldStatus)
	}
	if status != http.StatusOK {
		t.Fatalf("password change must return a replacement session: %d", status)
	}
	replacement, _ := changed.Data["accessToken"].(string)
	if replacement == "" {
		t.Fatal("missing replacement access token")
	}
	if next := mediaCookie(); next == "" || next == priorMedia {
		t.Fatal("password change must replace the scoped media Cookie")
	}
	for _, old := range []string{current, other} {
		if status, _ := s.do(http.MethodGet, "/api/v1/auth/me", old, nil); status != http.StatusUnauthorized {
			t.Errorf("old device access = %d, want 401", status)
		}
	}
	if status, _ := s.do(http.MethodGet, "/api/v1/auth/me", replacement, nil); status != http.StatusOK {
		t.Errorf("replacement access = %d", status)
	}
	// Cookie Path=/api/v1/auth means the password endpoint never receives the old
	// refresh Cookie. The response must install a replacement instead of relying on it.
	if status, _ := s.do(http.MethodPost, "/api/v1/auth/refresh", "", nil); status != http.StatusOK {
		t.Errorf("current browser refresh after password change = %d", status)
	}
}
