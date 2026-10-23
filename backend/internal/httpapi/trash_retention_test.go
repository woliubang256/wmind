package httpapi_test

import (
	"net/http"
	"testing"
	"time"
)

func TestTrashRetentionHTTP(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("retention")
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	uid := s.createMap(token, "期限测试")
	if status, _ := s.do(http.MethodDelete, "/api/v1/maps/"+uid, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete: %d", status)
	}
	read := func(days int) {
		t.Helper()
		status, body := s.do(http.MethodGet, "/api/v1/trash", token, nil)
		if status != http.StatusOK || len(body.Items) != 1 {
			t.Fatalf("trash response: %d %+v", status, body)
		}
		deleted, ok := body.Items[0]["deletedAt"].(string)
		if !ok {
			t.Fatalf("missing deletedAt: %+v", body.Items[0])
		}
		expires, ok := body.Items[0]["expiresAt"].(string)
		if !ok {
			t.Fatalf("missing expiresAt: %+v", body.Items[0])
		}
		at, err := time.Parse(time.RFC3339Nano, deleted)
		if err != nil {
			t.Fatal(err)
		}
		end, err := time.Parse(time.RFC3339Nano, expires)
		if err != nil {
			t.Fatal(err)
		}
		if end.Sub(at) != time.Duration(days)*24*time.Hour {
			t.Fatalf("expiration is not %d days: %s -> %s", days, deleted, expires)
		}
	}
	read(30)
	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", token, map[string]any{"trash.retention_days": 1}); status != http.StatusForbidden {
		t.Fatalf("non-admin changed retention: %d %+v", status, body)
	}
	if status, body := s.do(http.MethodPut, "/api/v1/admin/settings", admin, map[string]any{"trash.retention_days": 7}); status != http.StatusOK {
		t.Fatalf("update retention: %d %+v", status, body)
	}
	read(7)
	status, restored := s.do(http.MethodPost, "/api/v1/trash/"+uid+"/restore", token, nil)
	if status != http.StatusOK || restored.Data["deleted"] != false || restored.Data["expiresAt"] != nil || restored.Data["deletedAt"] != nil {
		t.Fatalf("restore retained deadline: %d %+v", status, restored)
	}
}
