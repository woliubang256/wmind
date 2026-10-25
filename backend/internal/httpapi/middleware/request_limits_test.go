package middleware

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type readDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (r *readDeadlineRecorder) SetReadDeadline(deadline time.Time) error {
	r.deadlines = append(r.deadlines, deadline)
	return nil
}

func TestRequestReadDeadlineIsScopedAndCleared(t *testing.T) {
	for _, tc := range []struct {
		path string
		want time.Duration
	}{
		{"/api/v1/ordinary", ordinaryReadTime},
		{"/api/v1/ai/generate", uploadReadTime},
		{"/api/v1/admin/backups/restore/preview", uploadReadTime},
		{"/api/v1/admin/backups/restore", ordinaryReadTime},
	} {
		t.Run(tc.path, func(t *testing.T) {
			router := gin.New()
			router.Use(RequestLimits())
			router.POST(tc.path, func(c *gin.Context) {
				_, _ = io.Copy(io.Discard, c.Request.Body)
				c.Status(http.StatusNoContent)
			})
			recorder := &readDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
			before := time.Now()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader("{}")))
			if len(recorder.deadlines) != 2 || !recorder.deadlines[1].IsZero() {
				t.Fatalf("request-scoped deadline was not set and cleared: %v", recorder.deadlines)
			}
			if got := recorder.deadlines[0].Sub(before); got < tc.want || got > tc.want+time.Second {
				t.Errorf("read deadline = %v; want %v", got, tc.want)
			}
		})
	}
}

func TestRequestLimitsNeverReadBeforeAuthentication(t *testing.T) {
	for _, path := range []string{"/api/v1/files", "/api/v1/ai/generate", "/api/v1/admin/backups/restore/preview"} {
		t.Run(path, func(t *testing.T) {
			router := gin.New()
			router.Use(RequestLimits())
			router.POST(path, func(c *gin.Context) { c.AbortWithStatus(http.StatusUnauthorized) })
			body := &unexpectedRequestRead{t: t}
			req := httptest.NewRequest(http.MethodPost, path, body)
			req.ContentLength = 2 << 30
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusUnauthorized {
				t.Errorf("authentication did not run first: %d", recorder.Code)
			}
		})
	}
}

type unexpectedRequestRead struct{ t *testing.T }

func (r *unexpectedRequestRead) Read([]byte) (int, error) {
	r.t.Error("body read before authentication")
	return 0, io.EOF
}
