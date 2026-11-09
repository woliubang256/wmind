package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/localmode"
	"github.com/woliubang256/wmind/backend/internal/bootstrap"
)

// 这组用例把云端客户端接到**真实的服务端路由**上（同一个 bootstrap 装配、
// 同一套登录加密与乐观锁），用来证明桌面端的同步协议与 Web 端完全兼容。
//
// 用假服务器测过的东西这里不再重复：这里要抓的是「两边都改了字段名/状态码，
// 各自的单测都绿，但合起来不通」这一类问题。
type cloudHarness struct {
	app       *bootstrap.App
	serverURL string
}

// 测试账号（SeedAdmin 创建）。
const harnessEmail = "sync@example.test"
const harnessPassword = "correct-horse-battery"

// enableTwoFactor 给测试账号打开两步验证，返回 TOTP 密钥。
func (h *cloudHarness) enableTwoFactor(t *testing.T, email, password string) string {
	t.Helper()
	ctx := context.Background()
	user, err := h.app.Users.GetByEmail(ctx, email)
	if err != nil {
		t.Fatalf("读取测试账号失败: %v", err)
	}
	setup, err := h.app.Auth.SetupTwoFactor(ctx, user.UID, password)
	if err != nil {
		t.Fatalf("初始化两步验证失败: %v", err)
	}
	code, err := totp.GenerateCode(setup.Secret, time.Now())
	if err != nil {
		t.Fatalf("生成动态码失败: %v", err)
	}
	if _, err := h.app.Auth.EnableTwoFactor(ctx, user.UID, password, code); err != nil {
		t.Fatalf("开启两步验证失败: %v", err)
	}
	return setup.Secret
}

func newCloudHarness(t *testing.T) (*cloud.Client, func()) {
	t.Helper()
	client, _, cleanup := newCloudServer(t)
	return client, cleanup
}

// newCloudServer 起一个真实的后端装配 + httptest 服务，并返回已登录的客户端。
func newCloudServer(t *testing.T) (*cloud.Client, *cloudHarness, func()) {
	t.Helper()

	paths, err := localmode.ResolvePaths(t.TempDir())
	if err != nil {
		t.Fatalf("解析数据目录失败: %v", err)
	}
	secrets, err := localmode.LoadSecrets(paths.Secrets)
	if err != nil {
		t.Fatalf("读取本地密钥失败: %v", err)
	}

	ctx := context.Background()
	app, err := bootstrap.New(ctx, localmode.Config(paths, secrets), bootstrap.Options{Logger: testLogger(), Quiet: true})
	if err != nil {
		t.Fatalf("装配后端失败: %v", err)
	}

	// 用 SeedAdmin 造一个已知密码的账号：桌面端连云端时就是拿账号密码登录。
	if _, err := app.Auth.SeedAdmin(ctx, harnessEmail, harnessPassword); err != nil {
		app.Close()
		t.Fatalf("创建测试账号失败: %v", err)
	}
	server := httptest.NewServer(app.Handler)
	harness := &cloudHarness{app: app, serverURL: server.URL}

	client, err := cloud.Login(ctx, server.URL, harnessEmail, harnessPassword)
	if err != nil {
		server.Close()
		app.Close()
		t.Fatalf("登录真实服务端失败: %v", err)
	}
	return client, harness, func() {
		server.Close()
		app.Close()
	}
}

func TestCloudClientAgainstRealServer(t *testing.T) {
	client, closeAll := newCloudHarness(t)
	defer closeAll()
	ctx := context.Background()

	// 1. 上传本地导图：沿用本地 uid。
	uid := "01JFA8Z3K5N7Q2R9T4V6W8X0Y1"
	doc := json.RawMessage(`{"format":"wmind","formatVersion":"1.0","id":"doc-1","title":"同步测试","sheets":[{"id":"s1","rootTopic":{"id":"root","title":"同步测试","children":{"attached":[]}}}]}`)
	uploaded, err := client.Upload(ctx, uid, "同步测试", doc)
	if err != nil {
		t.Fatalf("上传失败: %v", err)
	}
	if uploaded.UID != uid || uploaded.Version != 1 || uploaded.DocumentHash == "" {
		t.Fatalf("上传结果不符合预期: %+v", uploaded)
	}

	// 2. 重复上传必须幂等：仍是同一张图、版本不变。
	again, err := client.Upload(ctx, uid, "同步测试", doc)
	if err != nil {
		t.Fatalf("重复上传失败: %v", err)
	}
	if again.Version != 1 {
		t.Fatalf("重复上传不应产生新版本: %+v", again)
	}

	// 3. 增量拉取：游标取上传前的时刻，必须能拉到这张图。
	before := time.Now().UTC().Add(-time.Minute)
	changed, err := client.ListChanged(ctx, before)
	if err != nil {
		t.Fatalf("增量拉取失败: %v", err)
	}
	if len(changed) != 1 || changed[0].UID != uid {
		t.Fatalf("增量拉取结果不对: %+v", changed)
	}

	// 4. 按基线版本保存：版本对得上就成功，对不上给冲突详情。
	saved, err := client.Save(ctx, uid, 1, "同步测试 v2", doc)
	if err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if saved.Version != 2 {
		t.Fatalf("保存后版本 = %d; 期望 2", saved.Version)
	}

	_, err = client.Save(ctx, uid, 1, "过期版本", doc)
	conflict, ok := err.(*cloud.ConflictError)
	if !ok {
		t.Fatalf("过期版本应返回冲突，实际 %v", err)
	}
	if conflict.CurrentVersion != 2 || conflict.CurrentHash == "" {
		t.Fatalf("冲突详情不符合预期: %+v", conflict)
	}

	// 5. 详情里的指纹必须与保存响应一致——同步引擎靠它判断内容是否真的变了。
	detail, err := client.GetMap(ctx, uid)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if detail.DocumentHash != conflict.CurrentHash {
		t.Fatalf("详情指纹 %q 与冲突详情 %q 不一致", detail.DocumentHash, conflict.CurrentHash)
	}

	// 6. 删除后增量拉取仍能看到它（带删除标记）。
	if err := client.Delete(ctx, uid); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	changed, err = client.ListChanged(ctx, before)
	if err != nil {
		t.Fatalf("删除后增量拉取失败: %v", err)
	}
	if len(changed) != 1 || !changed[0].Deleted {
		t.Fatalf("删除后应当能拉到带标记的记录: %+v", changed)
	}

	// 7. 已删除的导图详情返回 404：同步引擎据此认为「云端已移除」。
	if _, err := client.GetMap(ctx, uid); err != cloud.ErrMapNotFound {
		t.Fatalf("已删除导图应返回 ErrMapNotFound，实际 %v", err)
	}
}

// 两步验证：真实服务端开启 2FA 后，桌面端登录必须先拿挑战令牌、再提交动态码。
func TestCloudLoginWithTwoFactorAgainstRealServer(t *testing.T) {
	_, harness, cleanup := newCloudServer(t)
	defer cleanup()
	ctx := context.Background()

	secret := harness.enableTwoFactor(t, harnessEmail, harnessPassword)

	// 第一步：密码对了，但只拿到挑战令牌。
	client, err := cloud.Login(ctx, harness.serverURL, harnessEmail, harnessPassword)
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	session := client.Session()
	if session.TwoFactorChallenge == "" {
		t.Fatal("开了两步验证的账号应当返回挑战令牌")
	}
	if session.AccessToken != "" {
		t.Fatal("验证动态码之前不该拿到访问令牌")
	}

	// 第二步：动态码错误要明确失败。
	if err := client.CompleteTwoFactor(ctx, "000000"); err == nil {
		t.Fatal("错误动态码应当报错")
	}

	// 第三步：正确动态码完成登录，拿到令牌与角色。
	//
	// 用下一个时间窗（+30s）：开启两步验证时已经消费了当前窗口的计数器，
	// 服务端只接受「比上次更大」的计数器（防重放），同一窗口的码会被拒。
	code, err := totp.GenerateCode(secret, time.Now().Add(30*time.Second))
	if err != nil {
		t.Fatalf("生成动态码失败: %v", err)
	}
	if err := client.CompleteTwoFactor(ctx, code); err != nil {
		t.Fatalf("验证动态码失败: %v", err)
	}
	session = client.Session()
	if session.AccessToken == "" || session.Role != "admin" {
		t.Fatalf("验证通过后应拿到令牌与管理员角色: %+v", session)
	}
	if session.TwoFactorChallenge != "" {
		t.Fatal("验证通过后应清掉挑战令牌")
	}

	// 令牌真的可用：拉一次增量。
	if _, err := client.ListChanged(ctx, time.Now().Add(-time.Hour)); err != nil {
		t.Fatalf("验证后调用接口失败: %v", err)
	}
}
