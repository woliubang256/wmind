package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// Requests bypass the fixture's CookieJar so an anonymous check never inherits
// a session created while preparing data for another assertion.
func authorizationRequest(t *testing.T, s *authTestServer, method, path, access string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	req.RemoteAddr = "203.0.113.19:12345"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if access != "" {
		req.Header.Set("Authorization", "Bearer "+access)
	}
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)
	return rec
}

func TestAuthorizationAllRoutesEnforceLoginAndAdminRole(t *testing.T) {
	s := newAuthTestServer(t)
	user := s.registerUser("boundarynormal")
	public := map[string]bool{
		"GET /api/v1/health/live":                  false,
		"GET /api/v1/health/ready":                 false,
		"GET /api/v1/site/config":                  false,
		"POST /api/v1/auth/register":               false,
		"POST /api/v1/auth/login":                  false,
		"POST /api/v1/auth/login/challenge":        false,
		"POST /api/v1/auth/2fa/verify":             false,
		"POST /api/v1/auth/refresh":                false,
		"POST /api/v1/auth/logout":                 false,
		"GET /api/v1/public/shares/:token":         false,
		"POST /api/v1/public/shares/:token/verify": false,
	}
	engine, ok := s.router.(*gin.Engine)
	if !ok {
		t.Fatalf("router = %T; want *gin.Engine", s.router)
	}
	protected, admins := 0, 0
	for _, route := range engine.Routes() {
		if !strings.HasPrefix(route.Path, "/api/v1/") {
			continue // Media has separate owner/share authorization tests.
		}
		operation := route.Method + " " + route.Path
		if _, anonymous := public[operation]; anonymous {
			public[operation] = true
			continue
		}
		segments := strings.Split(route.Path, "/")
		for i, segment := range segments {
			if strings.HasPrefix(segment, ":") {
				segments[i] = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
			}
		}
		path := strings.Join(segments, "/")
		t.Run("anonymous "+operation, func(t *testing.T) {
			rec := authorizationRequest(t, s, route.Method, path, "", nil)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("anonymous request = %d; want 401", rec.Code)
			}
		})
		protected++
		if strings.HasPrefix(route.Path, "/api/v1/admin/") {
			t.Run("ordinary user "+operation, func(t *testing.T) {
				rec := authorizationRequest(t, s, route.Method, path, user, nil)
				if rec.Code != http.StatusForbidden {
					t.Fatalf("ordinary user request = %d; want 403", rec.Code)
				}
			})
			admins++
		}
	}
	for operation, registered := range public {
		if !registered {
			t.Errorf("public allowlist entry not registered: %s", operation)
		}
	}
	if protected+len(public) != apiOperationCount || admins == 0 {
		t.Fatalf("incomplete route fixture: protected=%d, public=%d, admin=%d, total=%d", protected, len(public), admins, apiOperationCount)
	}
	t.Logf("checked %d authenticated API operations, including %d administrator operations", protected, admins)
}

func TestAuthorizationRelatedResourcesRejectOtherOwner(t *testing.T) {
	s := newAuthTestServer(t)
	owner := s.registerUser("boundaryowner")
	other := s.registerUser("boundaryother")
	uid := s.createMap(owner, "owner's unchanged map")
	s.createShare(owner, uid, map[string]any{})
	status, uploaded := s.uploadFile(owner, "file", "thumbnail.png", "image/png", pngBytes(t, 4, 4))
	if status != http.StatusOK {
		t.Fatalf("owner thumbnail upload = %d", status)
	}
	thumbnail := uploaded.Data["url"].(string)
	if status, _ := s.do(http.MethodPut, "/api/v1/maps/"+uid+"/thumbnail", owner, map[string]string{"thumbnailUrl": thumbnail}); status != http.StatusNoContent {
		t.Fatalf("owner thumbnail update = %d", status)
	}
	// Basic map CRUD, template/theme isolation and existing-share mutations have
	// dedicated tests. These are the cross-resource gaps found during the audit.
	for _, attempt := range []struct {
		name, method, path string
		body               any
	}{
		{"thumbnail", http.MethodPut, "/api/v1/maps/" + uid + "/thumbnail", map[string]string{"thumbnailUrl": ""}},
		{"create share", http.MethodPost, "/api/v1/maps/" + uid + "/shares", map[string]any{}},
	} {
		t.Run(attempt.name, func(t *testing.T) {
			rec := authorizationRequest(t, s, attempt.method, attempt.path, other, attempt.body)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("cross-owner request = %d; want 404", rec.Code)
			}
		})
	}
	status, shares := s.do(http.MethodGet, "/api/v1/maps/"+uid+"/shares", owner, nil)
	if status != http.StatusOK || len(shares.Items) != 1 {
		t.Fatalf("owner's share list changed: status=%d, count=%d", status, len(shares.Items))
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/maps/"+uid, owner, nil); status != http.StatusNoContent {
		t.Fatalf("owner delete = %d", status)
	}
	for _, attempt := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/trash/" + uid + "/restore"},
		{http.MethodDelete, "/api/v1/trash/" + uid},
	} {
		rec := authorizationRequest(t, s, attempt.method, attempt.path, other, nil)
		if rec.Code != http.StatusNotFound {
			t.Errorf("cross-owner %s = %d; want 404", attempt.path, rec.Code)
		}
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/trash/"+uid+"/restore", owner, nil); status != http.StatusOK {
		t.Fatalf("rejected requests damaged the owner's map: restore = %d", status)
	}
	status, restored := s.do(http.MethodGet, "/api/v1/maps/"+uid, owner, nil)
	if status != http.StatusOK || restored.Data["title"] != "owner's unchanged map" || restored.Data["thumbnailUrl"] != thumbnail {
		t.Fatalf("restored owner map = %d, title=%v, thumbnail=%v", status, restored.Data["title"], restored.Data["thumbnailUrl"])
	}
}

func TestAuthorizationProfileCannotEscalatePrivileges(t *testing.T) {
	s := newAuthTestServer(t)
	user := s.registerUser("boundaryprofile")
	status, before := s.do(http.MethodGet, "/api/v1/auth/me", user, nil)
	if status != http.StatusOK {
		t.Fatalf("profile setup = %d", status)
	}
	status, updated := s.do(http.MethodPatch, "/api/v1/users/me", user, map[string]any{
		"nickname": "permitted nickname", "role": "admin", "status": "disabled",
		"uid": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "id": 1,
	})
	if status != http.StatusOK || updated.Data["nickname"] != "permitted nickname" {
		t.Fatalf("permitted profile update = %d, nickname=%v", status, updated.Data["nickname"])
	}
	status, after := s.do(http.MethodGet, "/api/v1/auth/me", user, nil)
	if status != http.StatusOK || after.Data["uid"] != before.Data["uid"] || after.Data["role"] != "user" || after.Data["status"] != "active" {
		t.Fatalf("privileged profile fields changed: status=%d, user=%v", status, after.Data)
	}
	rec := authorizationRequest(t, s, http.MethodGet, "/api/v1/admin/settings", user, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("role injection enabled administrator access: %d", rec.Code)
	}
}
