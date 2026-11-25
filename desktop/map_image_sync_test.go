package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"

	"github.com/woliubang256/wmind/backend/desktop/internal/localserver"
)

func desktopCloudRequest(t *testing.T, local *localInstance, method, path, contentType string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	req.AddCookie(&http.Cookie{Name: localserver.CookieName, Value: local.ShellToken})
	req.Header.Set("Authorization", "Bearer "+local.AccessToken)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	local.Handler.ServeHTTP(rec, req)
	return rec
}

func putLocalSyncImage(t *testing.T, local *localInstance, pixel color.RGBA) (string, []byte) {
	t.Helper()
	var original, body bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.SetRGBA(0, 0, pixel)
	if err := png.Encode(&original, img); err != nil {
		t.Fatal(err)
	}
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "test.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(original.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	rec := desktopCloudRequest(t, local, http.MethodPost, "/api/v1/files", form.FormDataContentType(), &body)
	data := syncResponseData[struct{ URL string }](t, rec, http.StatusOK)
	return data.URL, original.Bytes()
}

func syncResponseData[T any](t *testing.T, rec *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("HTTP %d, want %d: %s", rec.Code, status, rec.Body.String())
	}
	var result struct{ Data T }
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Data
}

type syncImage struct {
	Src    string `json:"src"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

func syncImageDocument(t *testing.T, title string, images ...string) json.RawMessage {
	t.Helper()
	children := make([]any, 0, len(images))
	for i, src := range images {
		children = append(children, map[string]any{"id": string(rune('a' + i)), "title": "Image", "image": syncImage{src, 1, 1}})
	}
	raw, err := json.Marshal(map[string]any{
		"format": "wmind", "formatVersion": "1.0", "id": "image-doc", "title": title,
		"sheets": []any{map[string]any{"id": "s1", "rootTopic": map[string]any{
			"id": "root", "title": title, "children": map[string]any{"attached": children},
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func syncImageSources(t *testing.T, raw []byte) []string {
	t.Helper()
	var doc struct {
		Sheets []struct {
			RootTopic struct {
				Children struct {
					Attached []struct{ Image syncImage }
				}
			}
		}
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, child := range doc.Sheets[0].RootTopic.Children.Attached {
		out = append(out, child.Image.Src)
	}
	return out
}

func TestDesktopUploadsLocalMapImagesAndRetries(t *testing.T) {
	local := newLocal(t)
	_, cloudHarness, closeCloud := newCloudServer(t)
	defer closeCloud()
	var uploads atomic.Int32
	var loseCreateResponse atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/files" && uploads.Add(1) == 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/maps" && loseCreateResponse.CompareAndSwap(true, false) {
			rec := httptest.NewRecorder()
			cloudHarness.app.Handler.ServeHTTP(rec, r)
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		cloudHarness.app.Handler.ServeHTTP(w, r)
	}))
	defer server.Close()

	requestJSON := func(target *localInstance, method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return desktopCloudRequest(t, target, method, path, "application/json", bytes.NewReader(raw))
	}
	login := func(target *localInstance) {
		t.Helper()
		rec := requestJSON(target, http.MethodPost, "/desktop/cloud/connect", map[string]string{
			"serverUrl": server.URL, "identifier": harnessEmail, "password": harnessPassword,
		})
		syncResponseData[struct{}](t, rec, http.StatusOK)
	}

	first, firstBytes := putLocalSyncImage(t, local, color.RGBA{R: 255, A: 255})
	second, _ := putLocalSyncImage(t, local, color.RGBA{G: 255, A: 255})
	original := syncImageDocument(t, "Local map", first, second, first)
	rec := requestJSON(local, http.MethodPost, "/api/v1/maps", map[string]any{"title": "Local map", "document": original})
	localMap := syncResponseData[struct {
		UID     string
		Version int
	}](t, rec, http.StatusCreated)
	login(local)
	client := local.Engine.Client()
	rec = desktopCloudRequest(t, local, http.MethodPost, "/desktop/sync", "", nil)
	syncResponseData[struct{}](t, rec, http.StatusOK)
	if _, err := client.GetMap(t.Context(), localMap.UID); !errors.Is(err, cloud.ErrMapNotFound) || uploads.Load() != 0 {
		t.Fatalf("sync published an unbound local map: %v", err)
	}

	uploadPath := "/desktop/maps/" + localMap.UID + "/upload"
	rec = desktopCloudRequest(t, local, http.MethodPost, uploadPath, "", nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("interrupted image upload returned %d", rec.Code)
	}
	if uploaded, err := client.ListChanged(t.Context(), time.Unix(0, 0)); err != nil || len(uploaded) != 0 {
		t.Fatalf("partial upload published a map: %d, %v", len(uploaded), err)
	}
	loseCreateResponse.Store(true)
	rec = desktopCloudRequest(t, local, http.MethodPost, uploadPath, "", nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("lost creation response returned %d", rec.Code)
	}
	if _, err := client.GetMap(t.Context(), localMap.UID); err != nil {
		t.Fatalf("cloud did not create the map before the response was lost: %v", err)
	}
	rec = desktopCloudRequest(t, local, http.MethodPost, uploadPath, "", nil)
	binding := syncResponseData[struct {
		RemoteUID string
		State     string
	}](t, rec, http.StatusOK)
	if binding.RemoteUID != localMap.UID || binding.State != "synced" || uploads.Load() != 3 {
		t.Fatalf("unexpected binding or transfer count: %+v, %d", binding, uploads.Load())
	}
	rec = desktopCloudRequest(t, local, http.MethodPost, uploadPath, "", nil)
	syncResponseData[struct{}](t, rec, http.StatusOK)
	remoteMap, err := client.GetMap(t.Context(), localMap.UID)
	if err != nil {
		t.Fatal(err)
	}
	sources := syncImageSources(t, remoteMap.Document)
	if sources[0] == first || sources[1] == second || sources[0] != sources[2] || uploads.Load() != 3 {
		t.Fatalf("incorrect image mapping or repeated uploads: %v, %d", sources, uploads.Load())
	}
	if data, err := client.DownloadImage(t.Context(), sources[0]); err != nil || !bytes.Equal(data, firstBytes) {
		t.Fatalf("cloud image is unreadable: %v", err)
	}

	third, _ := putLocalSyncImage(t, local, color.RGBA{B: 255, A: 255})
	edited := syncImageDocument(t, "Edited locally", first, second, third)
	rec = requestJSON(local, http.MethodPut, "/api/v1/maps/"+localMap.UID, map[string]any{"title": "Edited locally", "version": localMap.Version, "document": edited})
	syncResponseData[struct{}](t, rec, http.StatusOK)
	rec = desktopCloudRequest(t, local, http.MethodPost, "/desktop/sync", "", nil)
	progress := syncResponseData[struct {
		Pushed int
		Failed []string
	}](t, rec, http.StatusOK)
	if progress.Pushed != 1 || len(progress.Failed) != 0 || uploads.Load() != 4 {
		t.Fatalf("follow-up sync failed or uploaded unchanged pictures: %+v, %d", progress, uploads.Load())
	}
	remoteMap, err = client.GetMap(t.Context(), localMap.UID)
	if err != nil || remoteMap.Version != 2 || remoteMap.Title != "Edited locally" {
		t.Fatalf("edited map not saved remotely: %+v, %v", remoteMap, err)
	}

	otherDesktop := newLocal(t)
	login(otherDesktop)
	rec = desktopCloudRequest(t, otherDesktop, http.MethodPost, "/desktop/sync", "", nil)
	pull := syncResponseData[struct {
		Pulled int
		Failed []string
	}](t, rec, http.StatusOK)
	if pull.Pulled != 1 || len(pull.Failed) != 0 {
		t.Fatalf("pulling map with images failed: %+v", pull)
	}
	rec = desktopCloudRequest(t, otherDesktop, http.MethodGet, "/api/v1/maps/"+localMap.UID, "", nil)
	copy := syncResponseData[struct{ Document json.RawMessage }](t, rec, http.StatusOK)
	otherDesktop.Engine.Disconnect()
	rec = desktopCloudRequest(t, otherDesktop, http.MethodGet, syncImageSources(t, copy.Document)[0], "", nil)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), firstBytes) {
		t.Fatalf("pulled image unavailable offline: HTTP %d", rec.Code)
	}
}
