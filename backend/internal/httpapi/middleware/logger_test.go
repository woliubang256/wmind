package middleware

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestLoggerRedactsSharePasswordQuery(t *testing.T) {
	for _, query := range []string{
		"psw=Ab9x&filter=mine", "psw=Ab%2B9&psw=Ab9x", "%70sw=Ab9x", "PSW=Ab9x", "psw=Ab9x&bad=%zz", "bad=foo;psw=Ab9x",
	} {
		t.Run(query, func(t *testing.T) {
			var buf bytes.Buffer
			r := gin.New()
			r.Use(Logger(slog.New(slog.NewJSONHandler(&buf, nil))))
			r.GET("/s/token", func(c *gin.Context) { c.Status(http.StatusOK) })
			r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/s/token?"+query, nil))
			if strings.Contains(buf.String(), "Ab9x") || strings.Contains(buf.String(), "Ab%2B9") {
				t.Fatal("password leaked into access log")
			}
			var entry map[string]any
			if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if entry["path"] != "/s/token" {
				t.Fatal("path lost")
			}
			if strings.Contains(query, "filter=mine") && !strings.Contains(entry["query"].(string), "filter=mine") {
				t.Fatal("non-sensitive query lost")
			}
		})
	}
}

func TestLoggerRedactsShareMediaCredentials(t *testing.T) {
	for _, query := range []string{
		"share=secret-share&access=secret-access&filter=mine",
		"share=secret-share&share=second-share&access=secret-access&access=second-access",
		"SHARE=secret-share&AcCeSs=secret-access",
		"%73hare=secret-share&%61ccess=secret-access",
		"share=secret-share&access=secret-access&bad=%zz",
		"bad=foo;share=secret-share&access=secret-access",
	} {
		t.Run(query, func(t *testing.T) {
			var buf bytes.Buffer
			r := gin.New()
			r.Use(Logger(slog.New(slog.NewJSONHandler(&buf, nil))))
			r.GET("/uploads/file.png", func(c *gin.Context) { c.Status(http.StatusOK) })
			r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/uploads/file.png?"+query, nil))
			for _, secret := range []string{"secret-share", "second-share", "secret-access", "second-access"} {
				if strings.Contains(buf.String(), secret) {
					t.Fatalf("share media credential %q leaked into access log", secret)
				}
			}
			var entry map[string]any
			if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if entry["path"] != "/uploads/file.png" {
				t.Fatal("path lost")
			}
			if strings.Contains(query, "filter=mine") && !strings.Contains(entry["query"].(string), "filter=mine") {
				t.Fatal("non-sensitive query lost")
			}
		})
	}
}
