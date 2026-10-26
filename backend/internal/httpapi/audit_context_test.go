package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAuditRecordsReadableIdentityAndKeepsEventNames(t *testing.T) {
	s := newAuthTestServer(t)
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	_, me := s.do(http.MethodGet, "/api/v1/auth/me", admin, nil)
	status, created := s.do(http.MethodPost, "/api/v1/admin/users", admin, map[string]string{
		"username": "audit-target", "email": "audit-target@example.com", "password": "correct-horse", "nickname": "原用户名称",
	})
	if status != http.StatusCreated {
		t.Fatalf("create = %d %#v", status, created.Error)
	}
	uid := created.Data["uid"].(string)
	if status, _ := s.do(http.MethodPatch, "/api/v1/users/me", admin, map[string]string{"nickname": "管理员新名称"}); status != http.StatusOK {
		t.Fatalf("rename actor = %d", status)
	}
	if status, _ := s.do(http.MethodPatch, "/api/v1/admin/users/"+uid, admin, map[string]string{"nickname": "新用户名称"}); status != http.StatusOK {
		t.Fatalf("rename target = %d", status)
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/admin/users/"+uid, admin, nil); status != http.StatusNoContent {
		t.Fatalf("delete target = %d", status)
	}
	status, logs := s.do(http.MethodGet, "/api/v1/admin/audit-logs?action=user.create", admin, nil)
	if status != http.StatusOK || len(logs.Items) != 1 {
		t.Fatalf("logs = %d %#v", status, logs.Items)
	}
	entry := logs.Items[0]
	actor, _ := entry["actor"].(map[string]any)
	if actor["uid"] != me.Data["uid"] || actor["username"] != me.Data["username"] || actor["nickname"] != me.Data["nickname"] {
		t.Fatalf("actor snapshot = %#v; want original %#v", actor, me.Data)
	}
	if entry["targetName"] != "原用户名称" {
		t.Fatalf("target snapshot = %#v", entry)
	}
}

func TestAuditShareCreateAndRevokeContainSafeMapContext(t *testing.T) {
	s := newAuthTestServer(t)
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	owner := s.registerUser("audit-owner")
	mapUID := s.createMap(owner, "分享审计原名称")
	share := s.createShare(owner, mapUID, map[string]any{"password": "Ab12", "expiresInDays": 7, "allowDownload": true, "showNotes": false})
	if status, _ := s.do(http.MethodDelete, "/api/v1/shares/"+share["uid"].(string), owner, nil); status != http.StatusNoContent {
		t.Fatalf("revoke = %d", status)
	}
	if status, _ := s.do(http.MethodPatch, "/api/v1/maps/"+mapUID, owner, map[string]string{"title": "后来改名"}); status != http.StatusOK {
		t.Fatalf("rename map = %d", status)
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/maps/"+mapUID, owner, nil); status != http.StatusNoContent {
		t.Fatalf("trash map = %d", status)
	}
	if status, _ := s.do(http.MethodDelete, "/api/v1/trash/"+mapUID, owner, nil); status != http.StatusNoContent {
		t.Fatalf("delete map = %d", status)
	}
	for _, action := range []string{"share.create", "share.revoke"} {
		status, logs := s.do(http.MethodGet, "/api/v1/admin/audit-logs?action="+action, admin, nil)
		if status != http.StatusOK || len(logs.Items) != 1 {
			t.Fatalf("%s logs = %d %#v", action, status, logs.Items)
		}
		entry := logs.Items[0]
		detail, _ := entry["detail"].(map[string]any)
		actor, _ := entry["actor"].(map[string]any)
		if entry["targetName"] != "分享审计原名称" || detail["mapTitle"] != "分享审计原名称" || detail["mapUid"] != mapUID || actor["username"] != "audit-owner" {
			t.Fatalf("%s context = %#v", action, entry)
		}
		if detail["hasPassword"] != true || detail["allowDownload"] != true || detail["showNotes"] != false || detail["expiresAt"] == nil {
			t.Fatalf("%s policy = %#v", action, detail)
		}
		raw, _ := json.Marshal(entry)
		if strings.Contains(string(raw), "Ab12") || strings.Contains(string(raw), share["token"].(string)) {
			t.Fatalf("sensitive value in %s audit", action)
		}
	}
}

func TestAuditLegacyContextAndDatePaginationUseExistingRecords(t *testing.T) {
	s := newAuthTestServer(t)
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	owner := s.registerUser("legacy-auditor")
	mapUID := s.createMap(owner, "仍存在的导图")
	share := s.createShare(owner, mapUID, map[string]any{"expiresInDays": 0})
	var actorID int64
	if err := s.db.QueryRow("SELECT id FROM users WHERE username = ?", "legacy-auditor").Scan(&actorID); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ target, detail, at string }{
		{share["uid"].(string), `{}`, "2026-10-25T10:00:00.000Z"},
		{"missing-share", `{}`, "2026-10-26T10:00:00.000Z"},
		{share["uid"].(string), `{}`, "2026-10-26T23:59:59.000Z"},
		{share["uid"].(string), `{}`, "2026-10-27T00:00:00.000Z"},
	} {
		if _, err := s.db.Exec("INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?)", actorID, "share.revoke", "share", item.target, item.detail, item.at); err != nil {
			t.Fatal(err)
		}
	}
	path := "/api/v1/admin/audit-logs?action=share.revoke&from=2026-10-26&to=2026-10-26&page_size=1"
	status, first := s.do(http.MethodGet, path, admin, nil)
	if status != http.StatusOK || first.Pagination == nil || first.Pagination.Total != 2 || len(first.Items) != 1 || first.Items[0]["targetName"] != "仍存在的导图" {
		t.Fatalf("first date page = %d %#v %#v", status, first.Pagination, first.Items)
	}
	status, second := s.do(http.MethodGet, path+"&page=2", admin, nil)
	if status != http.StatusOK || second.Pagination == nil || second.Pagination.Total != 2 || len(second.Items) != 1 || second.Items[0]["targetName"] != "" {
		t.Fatalf("missing legacy object = %d %#v", status, second.Items)
	}
	actor, _ := second.Items[0]["actor"].(map[string]any)
	if actor["username"] != "legacy-auditor" {
		t.Fatalf("legacy actor = %#v", actor)
	}
	var untouched string
	if err := s.db.QueryRow("SELECT detail FROM audit_logs WHERE action='share.revoke' AND target_id='missing-share'").Scan(&untouched); err != nil || untouched != `{}` {
		t.Fatalf("legacy record rewritten = %q %v", untouched, err)
	}
}

func TestAuditRejectsInvalidOrReversedTimeFilters(t *testing.T) {
	s := newAuthTestServer(t)
	admin := s.loginAs(testAdminEmail, testAdminPassword)
	for _, query := range []string{"from=garbage", "to=2026-02-30", "from=2026-10-27&to=2026-10-26", "from=2026-10-26T12:00:00Z&to=2026-10-26T11:00:00Z"} {
		status, body := s.do(http.MethodGet, "/api/v1/admin/audit-logs?"+query, admin, nil)
		if status != http.StatusUnprocessableEntity {
			t.Fatalf("%s = %d %#v; want 422", query, status, body.Error)
		}
	}
}
