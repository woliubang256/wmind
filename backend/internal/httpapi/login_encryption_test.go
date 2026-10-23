package httpapi_test

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"strings"
	"testing"
)

func (s *authTestServer) encryptedLogin(identifier, password string) map[string]string {
	s.t.Helper()
	status, response := s.do(http.MethodPost, "/api/v1/auth/login/challenge", "", map[string]string{"identifier": identifier})
	if status != http.StatusOK {
		s.t.Fatalf("challenge status = %d", status)
	}
	challenge := response.Data["challengeId"].(string)
	jwk := response.Data["publicKey"].(map[string]any)
	n, err := base64.RawURLEncoding.DecodeString(jwk["n"].(string))
	if err != nil {
		s.t.Fatal(err)
	}
	e, err := base64.RawURLEncoding.DecodeString(jwk["e"].(string))
	if err != nil {
		s.t.Fatal(err)
	}
	pub := rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	ciphertext, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &pub, []byte(password), []byte("wmind/login/v1:"+challenge))
	if err != nil {
		s.t.Fatal(err)
	}
	return map[string]string{"identifier": identifier, "challengeId": challenge, "encryptedPassword": base64.StdEncoding.EncodeToString(ciphertext)}
}

func TestLoginRejectsPlaintextPassword(t *testing.T) {
	s := newAuthTestServer(t)
	payload, err := json.Marshal(map[string]string{"identifier": testAdminEmail, "password": testAdminPassword})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, s.server.URL+"/api/v1/auth/login", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("plaintext login status = %d, want 400", response.StatusCode)
	}
}

func TestEncryptedLoginProtocol(t *testing.T) {
	s := newAuthTestServer(t)
	login := func(payload map[string]string, want int, code string) {
		t.Helper()
		status, response := s.do(http.MethodPost, "/api/v1/auth/login", "", payload)
		if status != want || (code != "" && response.Error.Code != code) {
			t.Fatalf("login status = %d, code = %s; want %d %s", status, response.Error.Code, want, code)
		}
	}
	t.Run("legacy bcrypt account and replay", func(t *testing.T) {
		payload := s.encryptedLogin(testAdminEmail, testAdminPassword)
		if strings.Contains(payload["encryptedPassword"], testAdminPassword) {
			t.Fatal("password exposed")
		}
		login(payload, 200, "")
		login(payload, 422, "AUTH_LOGIN_CHALLENGE_INVALID")
	})
	t.Run("wrong password consumes challenge", func(t *testing.T) {
		payload := s.encryptedLogin(testAdminEmail, "incorrect-password")
		login(payload, 401, "AUTH_INVALID_CREDENTIALS")
		login(payload, 422, "AUTH_LOGIN_CHALLENGE_INVALID")
	})
	t.Run("unknown account gets same challenge protocol", func(t *testing.T) {
		login(s.encryptedLogin("missing@example.com", testAdminPassword), 401, "AUTH_INVALID_CREDENTIALS")
	})
	t.Run("account cannot be replaced", func(t *testing.T) {
		payload := s.encryptedLogin(testAdminEmail, testAdminPassword)
		payload["identifier"] = "another@example.com"
		login(payload, 422, "AUTH_LOGIN_CHALLENGE_INVALID")
		payload["identifier"] = testAdminEmail
		login(payload, 200, "")
	})
	t.Run("tampering consumes challenge", func(t *testing.T) {
		payload := s.encryptedLogin(testAdminEmail, testAdminPassword)
		original := payload["encryptedPassword"]
		payload["encryptedPassword"] = strings.Repeat("A", 344)
		login(payload, 422, "AUTH_LOGIN_CHALLENGE_INVALID")
		payload["encryptedPassword"] = original
		login(payload, 422, "AUTH_LOGIN_CHALLENGE_INVALID")
	})
	t.Run("mixed plaintext is rejected before verification", func(t *testing.T) {
		payload := s.encryptedLogin(testAdminEmail, testAdminPassword)
		payload["password"] = testAdminPassword
		// Bypass the compatibility helper to exercise the exact wire format.
		raw, _ := json.Marshal(payload)
		request, _ := http.NewRequest(http.MethodPost, s.server.URL+"/api/v1/auth/login", bytes.NewReader(raw))
		response, err := s.client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("mixed request: %d", response.StatusCode)
		}
	})
}

func TestLoginChallengeHTTPGuards(t *testing.T) {
	s := newAuthTestServer(t)
	for _, body := range []string{
		`{"identifier":"alice","password":"never-accepted"}`,
		`{"identifier":"alice"} {"identifier":"other"}`,
		`{"identifier":"` + strings.Repeat("a", 5000) + `"}`,
		`null`,
	} {
		response, err := s.client.Post(s.server.URL+"/api/v1/auth/login/challenge", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("invalid challenge request status: %d", response.StatusCode)
		}
	}
	// A separate router gives the rate-limit test a fresh bucket.
	s = newAuthTestServer(t)
	for i := 0; i < 61; i++ {
		response, err := s.client.Post(s.server.URL+"/api/v1/auth/login/challenge", "application/json", strings.NewReader(`{"identifier":"unknown@example.com"}`))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		want := 200
		if i == 60 {
			want = 429
		}
		if response.StatusCode != want {
			t.Fatalf("challenge request %d: %d, want %d", i, response.StatusCode, want)
		}
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("challenge response %d must not be cached", i)
		}
		if response.Header.Get("Set-Cookie") != "" {
			t.Fatal("challenge issued a session cookie")
		}
	}
}
