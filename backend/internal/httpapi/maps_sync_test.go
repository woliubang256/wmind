package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	idgen "github.com/woliubang256/wmind/backend/internal/pkg/id"
)

// 这一组覆盖桌面端增量同步用到的 HTTP 契约（docs/11 §5）：
//
//   - GET /maps?updated_since= 增量拉取，含回收站里的导图；
//   - POST /maps 接受客户端 uid，且重复上传是幂等的；
//   - 409 冲突与详情里都带 documentHash，供客户端判断「内容其实没变」。
//
// 这些形状是桌面端同步引擎的唯一依据，改了必须在这里红。

// TestMapIncrementalSyncReturnsChanges 覆盖增量拉取的边界。
func TestMapIncrementalSyncReturnsChanges(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("syncpull")

	uid := s.createMap(token, "增量同步", "a", "b")

	// 取服务端自己的时间戳：客户端同步游标就是这么来的（不是本地时钟）。
	status, body := s.do(http.MethodGet, "/api/v1/maps/"+uid, token, nil)
	if status != http.StatusOK {
		t.Fatalf("读取导图 = %d %#v", status, body.Error)
	}
	updatedAt, _ := body.Data["updatedAt"].(string)
	if updatedAt == "" {
		t.Fatalf("详情缺少 updatedAt: %#v", body.Data)
	}
	created, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		t.Fatalf("updatedAt 不是 RFC3339: %v", err)
	}

	// 1. 游标在创建之前：必须包含这张图。
	since := created.Add(-time.Second).UTC().Format(time.RFC3339Nano)
	status, body = s.do(http.MethodGet, "/api/v1/maps?updated_since="+since, token, nil)
	if status != http.StatusOK {
		t.Fatalf("增量拉取 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 1 || body.Items[0]["uid"] != uid {
		t.Fatalf("增量拉取应当返回这张图: %#v", body.Items)
	}
	if deleted, _ := body.Items[0]["deleted"].(bool); deleted {
		t.Fatalf("未删除的导图不应带删除标记: %#v", body.Items[0])
	}
	if hash, _ := body.Items[0]["documentHash"].(string); hash == "" {
		t.Fatalf("增量结果必须带 documentHash: %#v", body.Items[0])
	}

	// 2. 删除也是一次变更：游标取创建时间，删除后仍要能被拉到。
	status, body = s.do(http.MethodDelete, "/api/v1/maps/"+uid, token, nil)
	if status != http.StatusNoContent {
		t.Fatalf("删除 = %d %#v", status, body.Error)
	}
	status, body = s.do(http.MethodGet, "/api/v1/maps?updated_since="+since, token, nil)
	if status != http.StatusOK {
		t.Fatalf("删除后增量拉取 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 1 {
		t.Fatalf("删除后增量拉取应当仍返回这张图（删除即变更）: %#v", body.Items)
	}
	if deleted, _ := body.Items[0]["deleted"].(bool); !deleted {
		t.Fatalf("删除后的导图必须带删除标记: %#v", body.Items[0])
	}

	// 3. 游标在未来：空集，客户端据此停止拉取。
	future := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	status, body = s.do(http.MethodGet, "/api/v1/maps?updated_since="+future, token, nil)
	if status != http.StatusOK {
		t.Fatalf("未来游标 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 0 {
		t.Fatalf("未来游标应当返回空集: %#v", body.Items)
	}

	// 4. 参数非法：明确报错，而不是悄悄退回普通列表。
	status, body = s.do(http.MethodGet, "/api/v1/maps?updated_since=yesterday", token, nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("非法游标期望 422，实际 %d %#v", status, body)
	}
	if body.Error == nil || body.Error.Code != "VALIDATION_FAILED" {
		t.Fatalf("非法游标应返回 VALIDATION_FAILED: %#v", body.Error)
	}
}

// TestMapUploadWithClientUIDIsIdempotent 覆盖桌面端「上传到云端」的幂等。
func TestMapUploadWithClientUIDIsIdempotent(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("syncpush")
	uid := idgen.New()

	upload := func() (int, apiResponse) {
		return s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
			"uid": uid, "title": "本地导图", "document": mapDoc("本地导图", "分支"),
		})
	}

	status, body := upload()
	if status != http.StatusCreated {
		t.Fatalf("首次上传 = %d %#v", status, body.Error)
	}
	if body.Data["uid"] != uid {
		t.Fatalf("上传应当沿用客户端 uid: %#v", body.Data["uid"])
	}

	// 重复上传（重试、双击、超时重发）：同一 uid，不产生第二份。
	status, body = upload()
	if status != http.StatusCreated {
		t.Fatalf("重复上传 = %d %#v", status, body.Error)
	}
	if body.Data["uid"] != uid {
		t.Fatalf("重复上传返回了别的 uid: %#v", body.Data["uid"])
	}
	status, body = s.do(http.MethodGet, "/api/v1/maps", token, nil)
	if status != http.StatusOK {
		t.Fatalf("列表 = %d %#v", status, body.Error)
	}
	if len(body.Items) != 1 {
		t.Fatalf("重复上传不应产生第二份，实际 %d 份", len(body.Items))
	}

	// uid 不合法：拒绝，而不是让非法字符串进数据库。
	status, body = s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"uid": "not-a-ulid", "title": "x", "document": mapDoc("x"),
	})
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("非法 uid 期望 422，实际 %d %#v", status, body)
	}
}

// TestMapUploadRejectsTrashedUID 覆盖「同名 uid 还在回收站」的语义：
// 既不能复用（会覆盖删除状态），也不能新建（唯一约束），必须明确告知。
func TestMapUploadRejectsTrashedUID(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("synctrash")
	uid := idgen.New()

	status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"uid": uid, "title": "待删", "document": mapDoc("待删"),
	})
	if status != http.StatusCreated {
		t.Fatalf("上传 = %d %#v", status, body.Error)
	}
	if status, body = s.do(http.MethodDelete, "/api/v1/maps/"+uid, token, nil); status != http.StatusNoContent {
		t.Fatalf("删除 = %d %#v", status, body.Error)
	}

	status, body = s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"uid": uid, "title": "重新上传", "document": mapDoc("重新上传"),
	})
	if status != http.StatusConflict {
		t.Fatalf("撞回收站里的 uid 期望 409，实际 %d %#v", status, body)
	}
	if body.Error == nil || body.Error.Code != "MAP_UID_CONFLICT" {
		t.Fatalf("应当返回 MAP_UID_CONFLICT: %#v", body.Error)
	}
}

// TestMapSaveConflictCarriesDocumentHash 覆盖冲突时的内容指纹：
// 客户端据此区分「真的冲突」与「只是版本号漂移」。
func TestMapSaveConflictCarriesDocumentHash(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("synchash")

	status, body := s.do(http.MethodPost, "/api/v1/maps", token, map[string]any{
		"title": "指纹", "document": mapDoc("指纹", "a"),
	})
	if status != http.StatusCreated {
		t.Fatalf("创建 = %d %#v", status, body.Error)
	}
	uid, _ := body.Data["uid"].(string)

	status, body = s.do(http.MethodPut, "/api/v1/maps/"+uid, token, map[string]any{
		"version": 1, "title": "指纹 v2", "document": mapDoc("指纹 v2", "a", "b"),
	})
	if status != http.StatusOK {
		t.Fatalf("保存 = %d %#v", status, body.Error)
	}
	savedHash, _ := body.Data["documentHash"].(string)
	if savedHash == "" {
		t.Fatalf("保存响应必须带 documentHash: %#v", body.Data)
	}

	// 用过期版本号再存一次：409，且详情里的指纹等于上一次保存的指纹。
	status, body = s.do(http.MethodPut, "/api/v1/maps/"+uid, token, map[string]any{
		"version": 1, "title": "冲突", "document": mapDoc("冲突"),
	})
	if status != http.StatusConflict {
		t.Fatalf("过期版本号期望 409，实际 %d %#v", status, body)
	}
	if body.Error == nil || body.Error.Code != "MAP_VERSION_CONFLICT" {
		t.Fatalf("应当返回 MAP_VERSION_CONFLICT: %#v", body.Error)
	}
	if got, _ := body.Error.Details["currentHash"].(string); got != savedHash {
		t.Fatalf("冲突详情里的指纹 = %q; 期望 %q", got, savedHash)
	}
	if version, _ := body.Error.Details["currentVersion"].(float64); version != 2 {
		t.Fatalf("冲突详情里的版本号 = %#v; 期望 2", body.Error.Details["currentVersion"])
	}

	// 详情接口同样给指纹，客户端拉取远端文档时用它作为新基线。
	status, body = s.do(http.MethodGet, "/api/v1/maps/"+uid, token, nil)
	if status != http.StatusOK {
		t.Fatalf("读取 = %d %#v", status, body.Error)
	}
	if got, _ := body.Data["documentHash"].(string); got != savedHash {
		t.Fatalf("详情里的指纹 = %q; 期望 %q", got, savedHash)
	}
}
