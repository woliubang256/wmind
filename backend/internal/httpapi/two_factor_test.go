package httpapi_test

import (
	"github.com/pquerna/otp/totp"
	"net/url"
	"testing"
	"time"
)

func TestTwoFactorHTTP(t *testing.T) {
	s := newAuthTestServer(t)
	status, r := s.do("POST", "/api/v1/auth/register", "", map[string]string{"username": "mfauser", "email": "mfa@example.test", "password": "factor-test-password"})
	if status != 201 {
		t.Fatal(status, r)
	}
	token := r.Data["accessToken"].(string)
	status, r = s.do("POST", "/api/v1/auth/2fa/setup", token, map[string]string{"password": "factor-test-password"})
	if status != 200 {
		t.Fatal(status, r)
	}
	code, _ := totp.GenerateCode(r.Data["secret"].(string), time.Now())
	status, r = s.do("POST", "/api/v1/auth/2fa/enable", token, map[string]string{"password": "factor-test-password", "code": code})
	if status != 200 {
		t.Fatal(status, r)
	}
	recovery := r.Data["recoveryCodes"].([]any)[0].(string)
	status, _ = s.do("GET", "/api/v1/auth/me", token, nil)
	if status != 401 {
		t.Fatal("old token accepted", status)
	}
	s.do("POST", "/api/v1/auth/logout", "", nil)
	status, r = s.do("POST", "/api/v1/auth/login", "", map[string]string{"identifier": "mfauser", "password": "factor-test-password"})
	if status != 200 || r.Data["twoFactorRequired"] != true || r.Data["accessToken"] != nil {
		t.Fatal(status, r)
	}
	cookieURL, _ := url.Parse(s.server.URL + "/api/v1/auth/refresh")
	if len(s.client.Jar.Cookies(cookieURL)) != 0 {
		t.Fatal("password step set session cookie")
	}
	challenge := r.Data["challengeToken"].(string)
	status, _ = s.do("GET", "/api/v1/auth/me", challenge, nil)
	if status != 401 {
		t.Fatal("challenge accepted", status)
	}
	status, r = s.do("POST", "/api/v1/auth/2fa/verify", "", map[string]string{"challengeToken": challenge, "code": "invalid"})
	if status != 422 {
		t.Fatal(status, r)
	}
	status, r = s.do("POST", "/api/v1/auth/2fa/verify", "", map[string]string{"challengeToken": challenge, "code": recovery})
	if status != 200 || r.Data["accessToken"] == nil {
		t.Fatal(status, r)
	}
	if len(s.client.Jar.Cookies(cookieURL)) != 1 {
		t.Fatal("second step did not set cookie")
	}
	status, _ = s.do("POST", "/api/v1/auth/refresh", "", nil)
	if status != 200 {
		t.Fatal("factor session cannot refresh", status)
	}
	status, _ = s.do("POST", "/api/v1/auth/2fa/verify", "", map[string]string{"challengeToken": challenge, "code": recovery})
	if status != 422 {
		t.Fatal("challenge reused", status)
	}
}
