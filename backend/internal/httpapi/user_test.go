package httpapi_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这一组测试覆盖「我的」页面的三个动作：改资料、改密、换头像。
// 它们都必须走真实 HTTP，因为头像那条路径上有 MaxBytesReader、multipart
// 解析和静态文件服务，单测 service 是碰不到的。

// registerUser 注册一个用户并返回访问令牌。
func (s *authTestServer) registerUser(username string) string {
	s.t.Helper()
	status, body := s.do(http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"username": username, "email": username + "@example.com",
		"password": "correct-horse", "nickname": username,
	})
	if status != http.StatusCreated {
		s.t.Fatalf("注册 %s = %d %#v", username, status, body.Error)
	}
	token, _ := body.Data["accessToken"].(string)
	if token == "" {
		s.t.Fatalf("注册 %s 没有返回访问令牌", username)
	}
	return token
}

// upload 发送一个 multipart 请求，filename/data 描述文件字段。
func (s *authTestServer) upload(path, token, filename string, data []byte) (int, apiResponse) {
	s.t.Helper()

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		s.t.Fatalf("构造 multipart: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		s.t.Fatalf("写入 multipart: %v", err)
	}
	if err := writer.Close(); err != nil {
		s.t.Fatalf("关闭 multipart: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, s.server.URL+path, &buf)
	if err != nil {
		s.t.Fatalf("构造请求: %v", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		s.t.Fatalf("发送上传请求: %v", err)
	}
	defer resp.Body.Close()

	var parsed apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		s.t.Fatalf("解析上传响应 (%d): %v", resp.StatusCode, err)
	}
	return resp.StatusCode, parsed
}

// testPNG 生成一张 width×height 的纯色 PNG。
func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 0x40, A: 0xff})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("编码 PNG: %v", err)
	}
	return buf.Bytes()
}

func TestUpdateProfileOverHTTP(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("alice")

	// 1. 只改昵称：邮箱保持原值（指针字段区分「没传」与「传空」）。
	status, body := s.do(http.MethodPatch, "/api/v1/users/me", token, map[string]string{
		"nickname": "Alice Liddell",
	})
	if status != http.StatusOK {
		t.Fatalf("改昵称 = %d %#v", status, body.Error)
	}
	if body.Data["nickname"] != "Alice Liddell" || body.Data["email"] != "alice@example.com" {
		t.Fatalf("改昵称后的用户 = %#v", body.Data)
	}

	// 2. 改邮箱：大小写与空白应被归一化。
	status, body = s.do(http.MethodPatch, "/api/v1/users/me", token, map[string]string{
		"email": "  ALICE.New@Example.COM  ",
	})
	if status != http.StatusOK || body.Data["email"] != "alice.new@example.com" {
		t.Fatalf("改邮箱 = %d %#v", status, body.Data)
	}

	// 3. 空 body：视为「什么都不改」，不该报错也不该清空资料。
	status, body = s.do(http.MethodPatch, "/api/v1/users/me", token, map[string]any{})
	if status != http.StatusOK || body.Data["nickname"] != "Alice Liddell" {
		t.Fatalf("空更新 = %d %#v", status, body.Data)
	}

	// 4. 邮箱格式错误 → 422，且错误定位到 email 字段。
	status, body = s.do(http.MethodPatch, "/api/v1/users/me", token, map[string]string{
		"email": "not-an-email",
	})
	fields, _ := body.Error.Details["fields"].(map[string]any)
	if status != http.StatusUnprocessableEntity || fields["email"] == nil {
		t.Fatalf("非法邮箱 = %d %#v", status, body.Error)
	}

	// 5. 昵称超长 → 422。
	status, body = s.do(http.MethodPatch, "/api/v1/users/me", token, map[string]string{
		"nickname": strings.Repeat("长", 33),
	})
	fields, _ = body.Error.Details["fields"].(map[string]any)
	if status != http.StatusUnprocessableEntity || fields["nickname"] == nil {
		t.Fatalf("超长昵称 = %d %#v", status, body.Error)
	}

	// 6. 撞上别人的邮箱 → 409。
	otherToken := s.registerUser("bob")
	if status, body := s.do(http.MethodPatch, "/api/v1/users/me", otherToken, map[string]string{
		"email": "alice.new@example.com",
	}); status != http.StatusConflict || body.Error.Code != "AUTH_EMAIL_TAKEN" {
		t.Fatalf("邮箱冲突 = %d %#v", status, body.Error)
	}

	// 7. 未登录 → 401。
	if status, body := s.do(http.MethodPatch, "/api/v1/users/me", "", map[string]string{
		"nickname": "nobody",
	}); status != http.StatusUnauthorized {
		t.Fatalf("未登录改资料 = %d %#v", status, body.Error)
	}
}

func TestChangePasswordOverHTTP(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("carol")

	// 1. 旧密码错误 → 401，且密码没被改。
	status, body := s.do(http.MethodPost, "/api/v1/users/me/password", token, map[string]string{
		"oldPassword": "not-my-password", "newPassword": "brand-new-secret",
	})
	if status != http.StatusUnauthorized || body.Error.Code != "AUTH_INVALID_CREDENTIALS" {
		t.Fatalf("旧密码错误 = %d %#v", status, body.Error)
	}

	// 2. 新密码过弱 → 422。
	status, body = s.do(http.MethodPost, "/api/v1/users/me/password", token, map[string]string{
		"oldPassword": "correct-horse", "newPassword": "123456",
	})
	if status != http.StatusUnprocessableEntity || body.Error.Code != "VALIDATION_FAILED" {
		t.Fatalf("弱密码 = %d %#v", status, body.Error)
	}

	// 3. 正常改密 → 200，返回当前设备替代会话。
	status, body = s.do(http.MethodPost, "/api/v1/users/me/password", token, map[string]string{
		"oldPassword": "correct-horse", "newPassword": "brand-new-secret",
	})
	if status != http.StatusOK {
		t.Fatalf("改密 = %d %#v", status, body.Error)
	}

	// 4. 新密码可登录，旧密码不可。
	if status, body := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "carol", "password": "brand-new-secret",
	}); status != http.StatusOK {
		t.Fatalf("新密码登录 = %d %#v", status, body.Error)
	}
	if status, _ := s.do(http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"identifier": "carol", "password": "correct-horse",
	}); status != http.StatusUnauthorized {
		t.Fatalf("旧密码登录 = %d; 期望 401", status)
	}
}

func TestUploadAvatarOverHTTP(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.registerUser("dave")

	// 1. 上传一张 400×300 的图：应被裁成正方形并落盘。
	status, body := s.upload("/api/v1/users/me/avatar", token, "me.png", testPNG(t, 400, 300))
	if status != http.StatusOK {
		t.Fatalf("上传头像 = %d %#v", status, body.Error)
	}
	first, _ := body.Data["avatarUrl"].(string)
	if !strings.HasPrefix(first, "/uploads/") || !strings.HasSuffix(first, ".png") {
		t.Fatalf("头像地址 = %q", first)
	}

	// 2. 静态文件服务能取到它，且确实是正方形 PNG。
	resp, err := s.client.Get(s.server.URL + first)
	if err != nil {
		t.Fatalf("获取头像: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("获取头像 = %d", resp.StatusCode)
	}
	cfg, err := png.DecodeConfig(resp.Body)
	if err != nil {
		t.Fatalf("解码头像: %v", err)
	}
	if cfg.Width != cfg.Height || cfg.Width != 256 {
		t.Fatalf("头像尺寸 = %dx%d; 期望 256x256", cfg.Width, cfg.Height)
	}

	// 3. 再传一张：新地址必须不同，旧文件被删掉（目录里只剩一个文件）。
	status, body = s.upload("/api/v1/users/me/avatar", token, "me2.png", testPNG(t, 300, 300))
	if status != http.StatusOK {
		t.Fatalf("二次上传 = %d %#v", status, body.Error)
	}
	second, _ := body.Data["avatarUrl"].(string)
	if second == first {
		t.Fatalf("两次上传得到同一个地址 %q", first)
	}
	if entries, err := os.ReadDir(s.uploads); err != nil {
		t.Fatalf("读取上传目录: %v", err)
	} else if len(entries) != 1 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("上传目录应只剩新头像，实际 %v", names)
	}

	// 4. 不是图片 → 415 FILE_TYPE_NOT_ALLOWED（靠解码判定，不看扩展名）。
	status, body = s.upload("/api/v1/users/me/avatar", token, "fake.png", []byte("this is not a png"))
	if status != http.StatusUnsupportedMediaType || body.Error.Code != "FILE_TYPE_NOT_ALLOWED" {
		t.Fatalf("上传假图片 = %d %#v", status, body.Error)
	}

	// 5. 超过大小上限 → 413 FILE_TOO_LARGE，且不会在磁盘留下半截文件。
	huge := make([]byte, 3<<20)
	status, body = s.upload("/api/v1/users/me/avatar", token, "huge.png", huge)
	if status != http.StatusRequestEntityTooLarge || body.Error.Code != "FILE_TOO_LARGE" {
		t.Fatalf("超大文件 = %d %#v", status, body.Error)
	}
	if body.Error.Details["maxBytes"] == nil {
		t.Fatalf("文件过大应带 maxBytes: %#v", body.Error.Details)
	}

	// 6. 未登录 → 401。
	if status, body := s.upload("/api/v1/users/me/avatar", "", "me.png", testPNG(t, 10, 10)); status != http.StatusUnauthorized {
		t.Fatalf("未登录上传 = %d %#v", status, body.Error)
	}
}

// 确保测试没有依赖工作目录里的残留文件。
func TestUploadDirIsolated(t *testing.T) {
	s := newAuthTestServer(t)
	if _, err := os.Stat(s.uploads); err == nil {
		entries, _ := os.ReadDir(s.uploads)
		if len(entries) != 0 {
			t.Fatalf("新测试服务器的上传目录应为空，实际 %d 个文件", len(entries))
		}
	}
	if filepath.Dir(s.uploads) == "." {
		t.Fatal("上传目录应位于临时目录下")
	}
}
