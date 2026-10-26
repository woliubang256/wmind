package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// APICachePolicy also covers early errors and unknown API routes. Media has
// its own policy because only generated public avatars may be cached.
func APICachePolicy() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		if path == "/api" || strings.HasPrefix(path, "/api/") {
			c.Header("Cache-Control", "no-store")
		}
		c.Next()
	}
}
