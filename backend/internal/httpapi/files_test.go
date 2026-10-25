package httpapi_test

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"path/filepath"
	"strings"
	"testing"
)

// pngBytes 造一张 w×h 的 PNG。
func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{R: 200, G: 40, B: 40, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("编码 PNG: %v", err)
	}
	return buf.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("编码 JPEG: %v", err)
	}
	return buf.Bytes()
}

func gifBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatalf("编码 GIF: %v", err)
	}
	return buf.Bytes()
}

// uploadFile 以 multipart 形式上传一个文件。
//
// 显式构造 multipart 而不是用 `s.do`：后者只发 JSON，而这里要验的正是
// 「multipart 里的字段名与文件名不影响结果」。
func (s *authTestServer) uploadFile(token, fieldName, fileName, contentType string, data []byte) (int, apiResponse) {
	s.t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="`+fieldName+`"; filename="`+fileName+`"`)
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	part, err := writer.CreatePart(header)
	if err != nil {
		s.t.Fatalf("构造 multipart: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		s.t.Fatalf("写入 multipart: %v", err)
	}
	if err := writer.Close(); err != nil {
		s.t.Fatalf("关闭 multipart: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, s.server.URL+"/api/v1/files", &body)
	if err != nil {
		s.t.Fatalf("构造请求: %v", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		s.t.Fatalf("发送请求: %v", err)
	}
	defer resp.Body.Close()

	var parsed apiResponse
	if resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(resp.Body)
		if err := parsed.UnmarshalJSON(raw); err != nil {
			s.t.Fatalf("解析响应 (%d, %s): %v", resp.StatusCode, raw, err)
		}
	}
	return resp.StatusCode, parsed
}

func TestFileUploadRejectsAnonymous(t *testing.T) {
	s := newAuthTestServer(t)

	status, body := s.uploadFile("", "file", "a.png", "image/png", pngBytes(t, 4, 4))
	if status != http.StatusUnauthorized {
		t.Fatalf("未登录上传 = %d %#v; 期望 401", status, body.Error)
	}
}

func TestFileUploadStoresImage(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	raw := pngBytes(t, 120, 80)
	status, body := s.uploadFile(token, "file", "whatever.png", "image/png", raw)
	if status != http.StatusOK {
		t.Fatalf("上传 = %d %#v", status, body.Error)
	}

	// 尺寸来自解码，不是客户端声明的。
	if w, _ := body.Data["width"].(float64); int(w) != 120 {
		t.Fatalf("width = %v; 期望 120", body.Data["width"])
	}
	if h, _ := body.Data["height"].(float64); int(h) != 80 {
		t.Fatalf("height = %v; 期望 80", body.Data["height"])
	}
	if format, _ := body.Data["format"].(string); format != "png" {
		t.Fatalf("format = %v; 期望 png", body.Data["format"])
	}

	url, _ := body.Data["url"].(string)
	if !strings.HasPrefix(url, "/uploads/file_") || !strings.HasSuffix(url, ".png") {
		t.Fatalf("url = %q; 期望 /uploads/file_<随机>.png", url)
	}

	// 文件真的落盘了，而且能按 URL 取回来（静态目录与存储目录必须同一个）。
	resp, err := s.client.Get(s.server.URL + url)
	if err != nil {
		t.Fatalf("取回文件: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("取回文件状态 = %d", resp.StatusCode)
	}
	got, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(got, raw) {
		t.Fatalf("取回内容与上传不一致（%d vs %d 字节）", len(got), len(raw))
	}
}

func TestFileUploadUsesDecodedFormatNotFileName(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	// 文件名撒谎：内容是 JPEG，名字叫 .png。落盘扩展名必须跟着**内容**走，
	// 否则静态目录会用 image/png 回放一段 JPEG 字节。
	status, body := s.uploadFile(token, "file", "photo.png", "image/png", jpegBytes(t, 10, 10))
	if status != http.StatusOK {
		t.Fatalf("上传 = %d %#v", status, body.Error)
	}
	url, _ := body.Data["url"].(string)
	if !strings.HasSuffix(url, ".jpg") {
		t.Fatalf("url = %q; 期望以 .jpg 结尾", url)
	}
	if format, _ := body.Data["format"].(string); format != "jpeg" {
		t.Fatalf("format = %v; 期望 jpeg", body.Data["format"])
	}
}

func TestFileUploadAcceptsGif(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	status, body := s.uploadFile(token, "file", "anim.gif", "image/gif", gifBytes(t, 8, 6))
	if status != http.StatusOK {
		t.Fatalf("上传 GIF = %d %#v", status, body.Error)
	}
	url, _ := body.Data["url"].(string)
	if !strings.HasSuffix(url, ".gif") {
		t.Fatalf("url = %q; 期望以 .gif 结尾", url)
	}
}

func TestFileUploadRejectsNonImage(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	// 判定靠解码，所以「文本改名成 .png」进不来。
	status, body := s.uploadFile(token, "file", "evil.png", "image/png", []byte("<script>alert(1)</script>"))
	if status != http.StatusUnsupportedMediaType {
		t.Fatalf("上传文本 = %d %#v; 期望 415", status, body.Error)
	}
	if body.Error == nil || body.Error.Code != "FILE_TYPE_NOT_ALLOWED" {
		t.Fatalf("错误码 = %#v; 期望 FILE_TYPE_NOT_ALLOWED", body.Error)
	}
}

func TestFileUploadRejectsEmpty(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	status, body := s.uploadFile(token, "file", "empty.png", "image/png", nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("上传空文件 = %d %#v; 期望 422", status, body.Error)
	}
}

func TestFileUploadRejectsTooLarge(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	// 一张 2000×2000 的随机噪声 PNG 会超过 8MB；用纯色图压不出体积，
	// 所以直接拼一段超过上限的字节——它连解码都过不了，但会被**字节闸门**
	// 先拦下，正是要验的顺序。
	huge := bytes.Repeat([]byte{0x89}, int(8<<20)+1)
	status, body := s.uploadFile(token, "file", "huge.png", "image/png", huge)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("上传超大文件 = %d %#v; 期望 413", status, body.Error)
	}
	if body.Error == nil || body.Error.Code != "FILE_TOO_LARGE" {
		t.Fatalf("错误码 = %#v; 期望 FILE_TOO_LARGE", body.Error)
	}
}

func TestFileUploadRejectsWrongFieldName(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	// 字段名必须是 file：前端与导入流程都按这个名字发。
	status, body := s.uploadFile(token, "upload", "a.png", "image/png", pngBytes(t, 4, 4))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("错误字段名 = %d %#v; 期望 422", status, body.Error)
	}
}

func TestFileUploadIsNotPubliclyReadable(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	status, body := s.uploadFile(token, "file", "a.png", "image/png", pngBytes(t, 4, 4))
	if status != http.StatusOK {
		t.Fatalf("上传 = %d %#v", status, body.Error)
	}
	url, _ := body.Data["url"].(string)

	// 随机地址不再是凭证；换一个不带 Cookie 的客户端必须拒绝。
	anon := &http.Client{}
	resp, err := anon.Get(s.server.URL + url)
	if err != nil {
		t.Fatalf("匿名取回: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("匿名取回 = %d; 期望 404", resp.StatusCode)
	}
}

func TestFileUploadNameIsRandom(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	raw := pngBytes(t, 4, 4)
	seen := make(map[string]bool, 5)
	for i := 0; i < 5; i++ {
		status, body := s.uploadFile(token, "file", "same.png", "image/png", raw)
		if status != http.StatusOK {
			t.Fatalf("第 %d 次上传 = %d %#v", i, status, body.Error)
		}
		uid, _ := body.Data["uid"].(string)
		if len(uid) != 32 {
			t.Fatalf("uid = %q（长度 %d）；期望 32 位十六进制", uid, len(uid))
		}
		if seen[uid] {
			t.Fatalf("uid 重复: %s", uid)
		}
		seen[uid] = true
	}
}

func TestUploadedFileLandsInStorageDir(t *testing.T) {
	s := newAuthTestServer(t)
	token := s.loginAs(testAdminEmail, testAdminPassword)

	status, body := s.uploadFile(token, "file", "a.png", "image/png", pngBytes(t, 4, 4))
	if status != http.StatusOK {
		t.Fatalf("上传 = %d %#v", status, body.Error)
	}
	url, _ := body.Data["url"].(string)
	name := strings.TrimPrefix(url, "/uploads/")

	// 直接看目录：上传成功但文件写到了别处，是「URL 打得开、重启就丢」的
	// 典型成因（存储目录与静态目录不是同一个）。
	if _, err := filepath.Glob(filepath.Join(s.uploads, name)); err != nil {
		t.Fatalf("在存储目录里找不到 %s: %v", name, err)
	}
}
