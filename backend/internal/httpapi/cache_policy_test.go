package httpapi_test

import (
	"net/http"
	"testing"
)

// Exercise the assembled router, including responses that abort before a
// handler runs. CDN rules must not turn public configuration or auth errors
// into reusable copies when no individual handler sets a cache policy.
func TestAPICachePolicyIncludesSuccessAndEarlyErrors(t *testing.T) {
	s := newAuthTestServer(t)
	for _, tc := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/api/v1/site/config", http.StatusOK},
		{http.MethodGet, "/api/v1/auth/me", http.StatusUnauthorized},
		{http.MethodGet, "/api/v1/maps/file.woff2", http.StatusUnauthorized},
		{http.MethodGet, "/api/v1/does-not-exist", http.StatusNotFound},
		{http.MethodPost, "/api/v1/site/config", http.StatusNotFound},
		{http.MethodGet, "/api", http.StatusNotFound},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			req, err := http.NewRequest(tc.method, s.server.URL+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := s.client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("status = %d; want %d", resp.StatusCode, tc.status)
			}
			if got := resp.Header.Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q; want no-store", got)
			}
		})
	}
}
