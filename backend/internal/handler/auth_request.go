package handler

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

const maxAuthJSONBytes = 4096

func allowSessionRequest(c *gin.Context, secure bool, allowEmpty bool) bool {
	c.Header("Cache-Control", "no-store")
	if !middleware.BrowserSessionAllowed(c, secure) {
		response.Fail(c, apperr.New(apperr.CodeAuthForbidden, ""))
		return false
	}
	if allowEmpty && c.Request.ContentLength == 0 {
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
