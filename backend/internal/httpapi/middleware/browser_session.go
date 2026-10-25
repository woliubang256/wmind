package middleware

import (
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

const ctxKeyAllowedSessionOrigin = "wmind.allowedSessionOrigin"

// BrowserSessionAllowed rejects cross-origin session writes before services can
// rotate credentials or emit Cookies. Requests without browser metadata remain
// available to non-browser JSON clients. Forwarded headers never authorize an origin.
func BrowserSessionAllowed(c *gin.Context, secureCookie bool) bool {
	mode := c.GetHeader("Sec-Fetch-Mode")
	if mode == "navigate" || mode == "no-cors" {
		return false
	}
	if origin := c.GetHeader("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return false
		}
		if allowed, _ := c.Get(ctxKeyAllowedSessionOrigin); allowed == true {
			return true
		}
		scheme := "http"
		if secureCookie || c.Request.TLS != nil || c.Request.URL.Scheme == "https" {
			scheme = "https"
		}
		return parsed.Scheme == scheme && sameOriginHost(parsed, &url.URL{Scheme: scheme, Host: c.Request.Host})
	}
	site := c.GetHeader("Sec-Fetch-Site")
	return site != "cross-site" && site != "same-site"
}

func sameOriginHost(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		if value := u.Port(); value != "" {
			return value
		}
		if u.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}
