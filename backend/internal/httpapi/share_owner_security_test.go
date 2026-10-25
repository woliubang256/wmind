package httpapi_test

import (
	"net/http"
	"testing"
)

func TestSharePublicAccessRequiresActiveOwner(t *testing.T) {
	for _, action := range []string{"disable", "delete"} {
		t.Run(action, func(t *testing.T) {
			s := newAuthTestServer(t)
			owner := s.registerUser("shareowner")
			_, profile := s.do(http.MethodGet, "/api/v1/auth/me", owner, nil)
			ownerUID := profile.Data["uid"].(string)
			mapUID := s.createMap(owner, "private-owner-map")
			plain := s.createShare(owner, mapUID, map[string]any{})
			protected := s.createShare(owner, mapUID, map[string]any{"password": "Ab4x"})
			protectedPath := "/api/v1/public/shares/" + protected["token"].(string)
			status, verified := s.do(http.MethodPost, protectedPath+"/verify", "", map[string]string{"password": "Ab4x"})
			if status != http.StatusOK {
				t.Fatalf("initial password verification = %d", status)
			}
			access := verified.Data["accessToken"].(string)
			admin := s.loginAs(testAdminEmail, testAdminPassword)
			adminPath := "/api/v1/admin/users/" + ownerUID
			if action == "disable" {
				status, _ = s.do(http.MethodPatch, adminPath, admin, map[string]string{"status": "disabled"})
				if status != http.StatusOK {
					t.Fatalf("disable owner = %d", status)
				}
			} else {
				status, _ = s.do(http.MethodDelete, adminPath, admin, nil)
				if status != http.StatusNoContent {
					t.Fatalf("delete owner = %d", status)
				}
			}

			for _, request := range []struct {
				method, path string
				body         any
				headers      map[string]string
			}{
				{http.MethodGet, "/api/v1/public/shares/" + plain["token"].(string), nil, nil},
				{http.MethodGet, protectedPath, nil, map[string]string{"X-Share-Access": access}},
				{http.MethodPost, protectedPath + "/verify", map[string]string{"password": "Ab4x"}, nil},
			} {
				status, response := s.doHeader(request.method, request.path, "", request.body, request.headers)
				if status != http.StatusNotFound || response.Error == nil || response.Error.Code != "SHARE_NOT_FOUND" || response.Data != nil {
					t.Errorf("%s for %s owner = %d %#v; want indistinguishable 404 without data", request.method, action, status, response)
				}
			}

			if action == "disable" {
				status, _ = s.do(http.MethodPatch, adminPath, admin, map[string]string{"status": "active"})
				if status != http.StatusOK {
					t.Fatalf("enable owner = %d", status)
				}
				status, _ = s.do(http.MethodGet, "/api/v1/public/shares/"+plain["token"].(string), "", nil)
				if status != http.StatusOK {
					t.Errorf("explicitly re-enabled owner's unrevoked share = %d; want 200", status)
				}
				status, _ = s.do(http.MethodPost, protectedPath+"/verify", "", map[string]string{"password": "Ab4x"})
				if status != http.StatusOK {
					t.Errorf("explicitly re-enabled owner's password verification = %d; want 200", status)
				}
			}
		})
	}
}
