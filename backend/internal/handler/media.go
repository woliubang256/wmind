package handler

import (
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/service"
)

type MediaHandler struct {
	files    *service.FileService
	sessions *service.AuthService
	shares   *service.ShareService
	dir      string
}

func NewMediaHandler(files *service.FileService, sessions *service.AuthService, shares *service.ShareService, dir string) *MediaHandler {
	return &MediaHandler{files: files, sessions: sessions, shares: shares, dir: dir}
}

// Get always authorizes before opening a file, including HEAD/Range/304. Only
// generated avatars are public; random file names are not bearer credentials.
func (h *MediaHandler) Get(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "no-referrer")
	key := c.Param("key")
	avatar := service.PublicAvatarKey(key)
	_, _, private := service.PrivateFileOwner(key)
	if !avatar && !private {
		c.Status(http.StatusNotFound)
		return
	}
	if !avatar && !h.authorized(c, key) {
		c.Status(http.StatusNotFound)
		return
	}
	root, err := os.OpenRoot(h.dir)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	defer root.Close()
	info, err := root.Lstat(key)
	if err != nil || !info.Mode().IsRegular() {
		c.Status(http.StatusNotFound)
		return
	}
	file, err := root.Open(key)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	defer file.Close()
	if avatar {
		c.Header("Cache-Control", "public, max-age=300")
	}
	http.ServeContent(c.Writer, c.Request, key, info.ModTime(), file)
}

func (h *MediaHandler) authorized(c *gin.Context, key string) bool {
	if token := c.Query("share"); token != "" {
		return h.shares != nil && h.shares.AuthorizeAsset(c.Request.Context(), token, c.Query("access"), key)
	}
	if h.sessions == nil || h.files == nil {
		return false
	}
	var ownerID int64
	if header := c.GetHeader("Authorization"); strings.TrimSpace(header) != "" {
		user, err := h.sessions.Authenticate(c.Request.Context(), middleware.BearerToken(header))
		if err != nil {
			return false
		}
		ownerID = user.ID
	} else {
		cookie, err := c.Cookie(MediaCookieName)
		if err != nil {
			return false
		}
		user, err := h.sessions.AuthenticateMedia(c.Request.Context(), cookie)
		if err != nil {
			return false
		}
		ownerID = user.ID
	}
	allowed, err := h.files.CanRead(c.Request.Context(), ownerID, key)
	return err == nil && allowed
}
