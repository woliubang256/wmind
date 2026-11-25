package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func nativeSessionRequest(t *testing.T, s *authTestServer, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1"+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wmind-Client", "desktop")
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)
	return rec
}

func TestNativeSessionUsesJSONWithoutCookies(t *testing.T) {
	s := newAuthTestServer(t)
	rec := nativeSessionRequest(t, s, "/auth/login", s.encryptedLogin(testAdminEmail, testAdminPassword))
	if rec.Code != http.StatusOK {
		t.Fatalf("native login = %d", rec.Code)
	}
	var result struct {
		Data struct {
			AccessToken      string    `json:"accessToken"`
			RefreshToken     string    `json:"refreshToken"`
			ExpiresIn        int       `json:"expiresIn"`
			RefreshExpiresAt time.Time `json:"refreshExpiresAt"`
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.AccessToken == "" || result.Data.RefreshToken == "" || result.Data.ExpiresIn != 900 {
		t.Fatal("native login did not return both tokens with a 15 minute access TTL")
	}
	if len(rec.Result().Cookies()) != 0 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("native session must not set Cookies or allow caching")
	}
	if left := time.Until(result.Data.RefreshExpiresAt); left < 30*24*time.Hour-time.Minute || left > 30*24*time.Hour {
		t.Fatalf("native refresh TTL = %s", left)
	}
	old := result.Data.RefreshToken
	rec = nativeSessionRequest(t, s, "/auth/refresh", map[string]string{"refreshToken": old})
	if rec.Code != http.StatusOK || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("native refresh = %d, Cookies=%d", rec.Code, len(rec.Result().Cookies()))
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.RefreshToken == "" || result.Data.RefreshToken == old {
		t.Fatal("native refresh token was not rotated")
	}
	rec = nativeSessionRequest(t, s, "/auth/logout", map[string]string{"refreshToken": result.Data.RefreshToken})
	if rec.Code != http.StatusNoContent || len(rec.Result().Cookies()) != 0 {
		t.Fatal("native logout must revoke without writing Cookies")
	}
	if rec = nativeSessionRequest(t, s, "/auth/refresh", map[string]string{"refreshToken": result.Data.RefreshToken}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("logged out refresh = %d", rec.Code)
	}
}

func TestNativeSessionRejectsBrowserAndCookieMixing(t *testing.T) {
	s := newAuthTestServer(t)
	for _, header := range []string{"Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Cookie"} {
		t.Run(header, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/challenge", bytes.NewBufferString(`{"identifier":"test"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Wmind-Client", "desktop")
			value := "same-origin"
			if header == "Origin" {
				value = "http://example.com"
			}
			if header == "Cookie" {
				value = "wmind_refresh=untrusted"
			}
			req.Header.Set(header, value)
			rec := httptest.NewRecorder()
			s.router.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden || len(rec.Result().Cookies()) != 0 {
				t.Fatalf("mixed native request = %d", rec.Code)
			}
		})
	}
}

func TestBrowserAuthResponseNeverExposesRefreshToken(t *testing.T) {
	s := newAuthTestServer(t)
	status, result := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{"identifier": testAdminEmail, "password": testAdminPassword})
	if status != http.StatusOK {
		t.Fatal(status)
	}
	if _, ok := result.Data["refreshToken"]; ok {
		t.Fatal("browser response exposed refresh token")
	}
	if _, ok := result.Data["refreshExpiresAt"]; ok {
		t.Fatal("browser response exposed native session fields")
	}
}
