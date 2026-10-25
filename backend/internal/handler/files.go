package handler

import (
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// FileHandler 处理通用图片上传。
//
// 读取由 MediaHandler 按会话、属主或当前分享权限授权。
type FileHandler struct {
	files    *service.FileService
	maxBytes int64
}

// NewFileHandler 构造文件 handler。
func NewFileHandler(files *service.FileService) *FileHandler {
	return &FileHandler{files: files, maxBytes: files.MaxBytes()}
}

// Upload 处理 POST /api/v1/files。
//
// 请求：`multipart/form-data`，字段 `file`。
// 响应：`{ uid, url, width, height, format, bytes }`。
func (h *FileHandler) Upload(c *gin.Context) {
	owner, ok := ownerID(c)
	if !ok {
		return
	}
	// 与头像一致：用 MaxBytesReader 提前卡住请求体，而不是先收完再判断。
	// multipartSlack 是表单头与 boundary 的余量，落在余量里的文件由
	// service 的字节检查兜住，两条路径都回 FILE_TOO_LARGE。
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, h.maxBytes+multipartSlack)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		response.Fail(c, uploadError(err, h.maxBytes))
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeInternalError, err))
		return
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(io.LimitReader(file, h.maxBytes+1))
	if err != nil {
		response.Fail(c, uploadError(err, h.maxBytes))
		return
	}

	uploaded, err := h.files.Upload(c.Request.Context(), owner, data)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, uploaded)
}
