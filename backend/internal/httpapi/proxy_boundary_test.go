package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
)

// Read the deployment default instead of hard-coding the fix into the fixture.
// Full Compose interpolation remains the responsibility of the deployment test.
func defaultComposeProxy(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("../../../deploy/docker-compose.yml")
	if err != nil {
		t.Fatal(err)
	}
	line := regexp.MustCompile(`(?m)^\s+WMIND_TRUSTED_PROXIES:\s+(.+)$`).FindSubmatch(data)
	if len(line) == 0 {
		return ""
	}
	ip := regexp.MustCompile(`\b172\.31\.254\.3\b`).Find(line[1])
	return string(ip)
}

func TestDefaultComposeSeparatesClientRateLimits(t *testing.T) {
	deps := testDeps()
	if proxy := defaultComposeProxy(t); proxy != "" {
		deps.Config.TrustedProxies = []string{proxy}
	}
	router := NewRouter(deps).(*gin.Engine)
	router.GET("/quota", middleware.NewRateLimiter(1, time.Hour, 1).Middleware(middleware.ClientIPKey), func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	request := func(peer, forwarded string) int {
		req := httptest.NewRequest(http.MethodGet, "/quota", nil)
		req.RemoteAddr = peer + ":12345"
		req.Header.Set("X-Forwarded-For", forwarded)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}
	if status := request("172.31.254.3", "198.51.100.11"); status != http.StatusOK {
		t.Fatalf("first client = %d", status)
	}
	if status := request("172.31.254.3", "198.51.100.11"); status != http.StatusTooManyRequests {
		t.Fatalf("same client's exhausted quota = %d; want 429", status)
	}
	if status := request("172.31.254.3", "198.51.100.22"); status != http.StatusOK {
		t.Fatalf("unrelated visitor behind the default proxy = %d; want independent quota", status)
	}
	// Nginx appends its real TCP peer. A forged prefix cannot move that peer
	// into a new rate bucket because only the exact web-container IP is trusted.
	if status := request("172.31.254.3", "203.0.113.99, 198.51.100.11"); status != http.StatusTooManyRequests {
		t.Fatalf("forged forwarded prefix bypassed the quota: %d", status)
	}
	if status := request("203.0.113.8", "198.51.100.77"); status != http.StatusOK {
		t.Fatalf("direct visitor = %d", status)
	}
	if status := request("203.0.113.8", "198.51.100.88"); status != http.StatusTooManyRequests {
		t.Fatalf("untrusted peer changed quota by spoofing XFF: %d", status)
	}
}

func TestTrustedProxyCanUseExplicitCustomAddress(t *testing.T) {
	deps := testDeps()
	deps.Config.TrustedProxies = []string{"192.0.2.40"}
	router := NewRouter(deps).(*gin.Engine)
	router.GET("/client", func(c *gin.Context) { c.String(http.StatusOK, c.ClientIP()) })
	for _, tc := range []struct{ peer, want string }{{"192.0.2.40", "198.51.100.5"}, {"192.0.2.41", "192.0.2.41"}} {
		req := httptest.NewRequest(http.MethodGet, "/client", nil)
		req.RemoteAddr = tc.peer + ":12345"
		req.Header.Set("X-Forwarded-For", "198.51.100.5")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if got := strings.TrimSpace(rec.Body.String()); got != tc.want {
			t.Errorf("peer %s resolved to %q; want %q", tc.peer, got, tc.want)
		}
	}
}
