package handler

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

const maxAuthJSONBytes = 4096

// NativeClientHeader explicitly selects JSON credentials, never browser Cookies.
const NativeClientHeader = "X-Wmind-Client"

func nativeSession(c *gin.Context) bool {
	return c.GetHeader(NativeClientHeader) == "desktop"
}

func allowSessionRequest(c *gin.Context, secure bool, allowEmpty bool) bool {
	c.Header("Cache-Control", "no-store")
	if client := c.GetHeader(NativeClientHeader); client != "" {
		if client != "desktop" {
			response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
			return false
		}
		// A browser cannot opt into readable refresh credentials. Reject even
		// trusted origins and empty browser metadata before any session mutation.
		for name := range c.Request.Header {
			name = strings.ToLower(name)
			if name == "origin" || name == "cookie" || strings.HasPrefix(name, "sec-fetch-") {
				response.Fail(c, apperr.New(apperr.CodeAuthForbidden, ""))
				return false
			}
		}
	}
	if !middleware.BrowserSessionAllowed(c, secure) {
		response.Fail(c, apperr.New(apperr.CodeAuthForbidden, ""))
		return false
	}
	if allowEmpty && !nativeSession(c) && c.Request.ContentLength == 0 {
		return true
	}
	mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || mediaType != "application/json" {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
		return false
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAuthJSONBytes)
	return true
}

func bindAuthJSON(c *gin.Context, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, maxAuthJSONBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		response.Fail(c, apperr.New(apperr.CodeBadRequest, ""))
		return false
	}
	return true
}
