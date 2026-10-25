package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestBrowserSessionOriginBoundaries(t *testing.T) {
	for _, test := range []struct {
		name, origin, site, mode string
		secure, allowed          bool
		origins                  []string
	}{
		{name: "non-browser", allowed: true},
		{name: "same origin", origin: "http://example.test", site: "same-origin", allowed: true},
		{name: "secure proxy", origin: "https://example.test", secure: true, allowed: true},
		{name: "secure protocol mismatch", origin: "http://example.test", secure: true},
		{name: "case insensitive default port", origin: "http://EXAMPLE.TEST:80", allowed: true},
		{name: "different port", origin: "http://example.test:5173"},
		{name: "foreign origin", origin: "https://attacker.invalid"},
		{name: "opaque origin", origin: "null"},
		{name: "origin with path", origin: "http://example.test/path"},
		{name: "origin with credentials", origin: "http://user@example.test"},
		{name: "missing origin cross site", site: "cross-site"},
		{name: "missing origin sibling site", site: "same-site"},
		{name: "missing origin same origin", site: "same-origin", allowed: true},
		{name: "navigation", origin: "http://example.test", mode: "navigate"},
		{name: "no cors", mode: "no-cors"},
		{name: "configured development origin", origin: "http://localhost:5173", site: "cross-site", mode: "cors", origins: []string{"http://localhost:5173"}, allowed: true},
		{name: "unconfigured development port", origin: "http://localhost:5174", origins: []string{"http://localhost:5173"}},
		{name: "configured source cannot navigate", origin: "http://localhost:5173", mode: "navigate", origins: []string{"http://localhost:5173"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			router := gin.New()
			router.Use(CORS(test.origins))
			router.POST("/session", func(c *gin.Context) {
				if BrowserSessionAllowed(c, test.secure) {
					c.Status(http.StatusNoContent)
				} else {
					c.Status(http.StatusForbidden)
				}
			})
			request := httptest.NewRequest(http.MethodPost, "http://example.test/session", nil)
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Sec-Fetch-Site", test.site)
			request.Header.Set("Sec-Fetch-Mode", test.mode)
			request.Header.Set("X-Forwarded-Proto", "https")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if (recorder.Code == http.StatusNoContent) != test.allowed {
				t.Fatalf("session status = %d, allowed=%v", recorder.Code, test.allowed)
			}
		})
	}
}
