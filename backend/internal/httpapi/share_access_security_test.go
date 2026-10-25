package httpapi_test

import (
	"net/http"
	"testing"
)

func TestSharePasswordResetRevokesOldPublicAccess(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("shareowner")
	mapUID := s.createMap(owner, "private-map")
	share := s.createShare(owner, mapUID, map[string]any{"password": "Ab4x"})
	path := "/api/v1/public/shares/" + share["token"].(string)
	status, verified := s.do(http.MethodPost, path+"/verify", "", map[string]string{"password": "Ab4x"})
	if status != http.StatusOK {
		t.Fatalf("verify initial password = %d", status)
	}
	headers := map[string]string{"X-Share-Access": verified.Data["accessToken"].(string)}
	status, _ = s.do(http.MethodPatch, "/api/v1/shares/"+share["uid"].(string), owner, map[string]string{"password": "Zy8q"})
	if status != http.StatusOK {
		t.Fatalf("reset password = %d", status)
	}
	status, rejected := s.doHeader(http.MethodGet, path, "", nil, headers)
	if status != http.StatusUnauthorized || rejected.Error == nil || rejected.Error.Code != "SHARE_PASSWORD_REQUIRED" || rejected.Data != nil {
		t.Fatalf("previously verified access = %d %#v; want 401 without map", status, rejected.Error)
	}
	status, _ = s.do(http.MethodPost, path+"/verify", "", map[string]string{"password": "Ab4x"})
	if status != http.StatusUnauthorized {
		t.Fatalf("old password = %d; want 401", status)
	}
	status, fresh := s.do(http.MethodPost, path+"/verify", "", map[string]string{"password": "Zy8q"})
	if status != http.StatusOK {
		t.Fatalf("new password = %d", status)
	}
	status, public := s.doHeader(http.MethodGet, path, "", nil, map[string]string{"X-Share-Access": fresh.Data["accessToken"].(string)})
	if status != http.StatusOK || public.Data["document"] == nil {
		t.Fatalf("newly verified access = %d %#v", status, public.Error)
	}
	for _, forbidden := range []string{"password", "passwordHash", "passwordCiphertext", "email", "ownerUid"} {
		if _, exists := public.Data[forbidden]; exists {
			t.Errorf("public response contains %q", forbidden)
		}
	}
}
