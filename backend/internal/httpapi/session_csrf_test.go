package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/handler"
)

func TestSessionRefreshRejectsCrossSiteForms(t *testing.T) {
	for _, contentType := range []string{"text/plain", "application/json"} {
		t.Run(contentType, func(t *testing.T) {
			s := newAuthTestServer(t)
			s.registerUser("csrfaccount")
			u, _ := url.Parse(s.server.URL + "/api/v1/auth/refresh")
			refresh := ""
			for _, cookie := range s.client.Jar.Cookies(u) {
				if cookie.Name == handler.RefreshCookieName {
					refresh = cookie.Value
				}
			}
			if refresh == "" {
				t.Fatal("fixture did not create refresh Cookie")
			}
			body := `{"refreshToken":"` + refresh + `","padding":"="}` + "\r\n"
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", strings.NewReader(body))
			req.Header.Set("Content-Type", contentType)
			req.Header.Set("Origin", "https://attacker.invalid")
			req.Header.Set("Sec-Fetch-Site", "cross-site")
			req.Header.Set("Sec-Fetch-Mode", "navigate")
			rec := httptest.NewRecorder()
			s.router.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Errorf("cross-site request = %d, want 403", rec.Code)
			}
			if len(rec.Header().Values("Set-Cookie")) != 0 {
				t.Error("rejected request must not create or clear session Cookies")
			}
		})
	}
}

func TestSessionRefreshAcceptsTrustedRequests(t *testing.T) {
	for _, mode := range []string{"empty Cookie", "same-origin Cookie", "non-browser JSON", "Cookie overrides body"} {
		t.Run(mode, func(t *testing.T) {
			s := newAuthTestServer(t)
			s.registerUser("trustedclient")
			u, _ := url.Parse(s.server.URL + "/api/v1/auth/refresh")
			var cookie *http.Cookie
			for _, value := range s.client.Jar.Cookies(u) {
				if value.Name == handler.RefreshCookieName {
					cookie = value
				}
			}
			if cookie == nil {
				t.Fatal("missing fixture refresh Cookie")
			}
			body := ""
			if mode == "non-browser JSON" {
				raw, _ := json.Marshal(map[string]string{"refreshToken": cookie.Value})
				body = string(raw)
			}
			if mode == "Cookie overrides body" {
				body = `{"refreshToken":"untrusted-body-token"}`
			}
			request := httptest.NewRequest(http.MethodPost, "http://example.test/api/v1/auth/refresh", strings.NewReader(body))
			if body != "" {
				request.Header.Set("Content-Type", "application/json; charset=utf-8")
			}
			if mode != "non-browser JSON" {
				request.AddCookie(cookie)
			}
			if mode == "same-origin Cookie" {
				request.Header.Set("Origin", "http://example.test")
				request.Header.Set("Sec-Fetch-Site", "same-origin")
				request.Header.Set("Sec-Fetch-Mode", "cors")
			}
			recorder := httptest.NewRecorder()
			s.router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("trusted refresh = %d: %s", recorder.Code, recorder.Body.String())
			}
			if len(recorder.Result().Cookies()) != 2 {
				t.Fatal("refresh must rotate authentication and scoped media Cookies")
			}
		})
	}
}

func TestSessionRejectedBrowserRequestDoesNotRevokeCookie(t *testing.T) {
	s := newAuthTestServer(t)
	s.registerUser("csrfvictim")
	u, _ := url.Parse(s.server.URL + "/api/v1/auth/refresh")
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	for _, cookie := range s.client.Jar.Cookies(u) {
		request.AddCookie(cookie)
	}
	request.Header.Set("Sec-Fetch-Site", "same-site")
	recorder := httptest.NewRecorder()
	s.router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || len(recorder.Header().Values("Set-Cookie")) != 0 {
		t.Fatal("sibling-origin logout was not rejected without side effects")
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/auth/refresh", "", nil); status != http.StatusOK {
		t.Fatalf("rejected logout revoked victim refresh: %d", status)
	}
}

func TestSessionRefreshFailureCannotClearNewerSessionCookies(t *testing.T) {
	s := newAuthTestServer(t)
	access := s.registerUser("latecookie")
	u, _ := url.Parse(s.server.URL + "/api/v1/auth/refresh")
	var prior *http.Cookie
	for _, cookie := range s.client.Jar.Cookies(u) {
		if cookie.Name == handler.RefreshCookieName {
			prior = cookie
		}
	}
	if prior == nil {
		t.Fatal("missing initial Cookie")
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/users/me/password", access, map[string]string{"oldPassword": "correct-horse", "newPassword": "new-correct-horse"}); status != http.StatusOK {
		t.Fatalf("password change = %d", status)
	}
	// A request already dispatched with the old Cookie can arrive after the
	// password response. Its 401 must not overwrite the browser's newer Cookies.
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	request.AddCookie(prior)
	recorder := httptest.NewRecorder()
	s.router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("old refresh = %d", recorder.Code)
	}
	if len(recorder.Header().Values("Set-Cookie")) != 0 {
		t.Error("late old-session rejection can overwrite the browser's new session Cookies")
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/auth/refresh", "", nil); status != http.StatusOK {
		t.Fatalf("new browser session refresh = %d", status)
	}
}

func TestSessionCookieWritersRejectUntrustedBrowser(t *testing.T) {
	s := newAuthTestServer(t)
	for _, path := range []string{"/auth/register", "/auth/login/challenge", "/auth/login", "/auth/2fa/verify", "/auth/refresh", "/auth/logout"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1"+path, strings.NewReader(`{}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "https://attacker.invalid")
			recorder := httptest.NewRecorder()
			s.router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("untrusted browser status = %d", recorder.Code)
			}
			if len(recorder.Header().Values("Set-Cookie")) != 0 {
				t.Fatal("untrusted browser changed session Cookies")
			}
		})
	}
}

func TestSessionJSONRejectsInvalidBodies(t *testing.T) {
	s := newAuthTestServer(t)
	for _, test := range []struct{ name, contentType, body string }{
		{"plain form", "text/plain", `{"identifier":"alice"}`},
		{"form encoded", "application/x-www-form-urlencoded", `identifier=alice`},
		{"too large", "application/json", `{"identifier":"` + strings.Repeat("a", 5000) + `"}`},
		{"unknown field", "application/json", `{"identifier":"alice","password":"not-allowed"}`},
		{"trailing JSON", "application/json", `{"identifier":"alice"}{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/challenge", strings.NewReader(test.body))
			request.Header.Set("Content-Type", test.contentType)
			recorder := httptest.NewRecorder()
			s.router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("invalid JSON status = %d", recorder.Code)
			}
			if len(recorder.Header().Values("Set-Cookie")) != 0 {
				t.Fatal("invalid JSON changed session Cookies")
			}
		})
	}
}
