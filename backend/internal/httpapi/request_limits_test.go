package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRouterBoundsOrdinaryBodiesBeforeHandlers(t *testing.T) {
	for _, knownLength := range []bool{true, false} {
		t.Run(map[bool]string{true: "content-length", false: "chunked"}[knownLength], func(t *testing.T) {
			router := NewRouter(testDeps()).(*gin.Engine)
			var read int64
			called := false
			router.POST("/api/v1/probe", func(c *gin.Context) {
				called = true
				var err error
				read, err = io.Copy(io.Discard, c.Request.Body)
				if err != nil {
					c.Status(http.StatusBadRequest)
					return
				}
				c.Status(http.StatusNoContent)
			})
			req := httptest.NewRequest(http.MethodPost, "/api/v1/probe", strings.NewReader(strings.Repeat("x", (1<<20)+1)))
			if !knownLength {
				req.ContentLength = -1
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if knownLength {
				if rec.Code != http.StatusRequestEntityTooLarge || called {
					t.Errorf("known oversized body = %d, reached handler=%t; want early 413", rec.Code, called)
				}
			} else if read > 1<<20 || rec.Code == http.StatusNoContent {
				t.Errorf("unknown-length body = %d bytes, status %d; must stop decoding at 1MiB", read, rec.Code)
			}
		})
	}
}

func TestRouterKeepsLargeDocumentAndDedicatedUploadPaths(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{http.MethodPost, "/api/v1/maps", http.StatusNoContent},
		{http.MethodPut, "/api/v1/maps/map-1", http.StatusNoContent},
		{http.MethodPost, "/api/v1/maps/map-1/shares", http.StatusRequestEntityTooLarge},
		{http.MethodPost, "/api/v1/themes", http.StatusRequestEntityTooLarge},
		{http.MethodPost, "/api/v1/ai/generate", http.StatusNoContent},
		{http.MethodPost, "/api/v1/files", http.StatusNoContent},
		{http.MethodPost, "/api/v1/users/me/avatar", http.StatusNoContent},
		{http.MethodPost, "/api/v1/admin/backups/restore/preview", http.StatusNoContent},
		{http.MethodPost, "/api/v1/admin/backups/restore", http.StatusRequestEntityTooLarge},
		{http.MethodPut, "/api/v1/files", http.StatusRequestEntityTooLarge},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			router := NewRouter(testDeps()).(*gin.Engine)
			path := tc.path
			if path == "/api/v1/maps/map-1" {
				path = "/api/v1/maps/:uid"
			}
			router.Handle(tc.method, path, func(c *gin.Context) {
				if _, err := io.Copy(io.Discard, c.Request.Body); err != nil {
					c.Status(http.StatusBadRequest)
					return
				}
				c.Status(http.StatusNoContent)
			})
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(strings.Repeat("x", 2<<20)))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d; want %d", rec.Code, tc.want)
			}
		})
	}
}
