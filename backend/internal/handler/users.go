package handler

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/httpapi/response"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// UserHandler 处理「我的」相关接口：资料、密码、头像。
type UserHandler struct {
	users *service.UserService
	auth  *service.AuthService
	// cookieName 是刷新令牌 Cookie 的名字，改密时用来定位「当前设备」。
	cookieName string
	// maxAvatarBytes 同时用于 HTTP 层的读取上限与错误信息。
	maxAvatarBytes int64
}

// NewUserHandler 构造用户 handler。
//
// cookieName 由调用方从同一个 CookieConfig 传进来，而不是在这里再算一遍：
// 两处各写一份默认值，改配置时必然漏掉一处。
func NewUserHandler(
	users *service.UserService,
	auth *service.AuthService,
	cookieName string,
	maxAvatarBytes int64,
) *UserHandler {
	if cookieName == "" {
		cookieName = RefreshCookieName
	}
	if maxAvatarBytes <= 0 {
		maxAvatarBytes = service.DefaultMaxAvatarBytes
	}
	return &UserHandler{
		users: users, auth: auth, cookieName: cookieName, maxAvatarBytes: maxAvatarBytes,
	}
}

type updateProfileRequest struct {
	Nickname *string `json:"nickname"`
	Email    *string `json:"email"`
}

// UpdateMe 处理 PATCH /api/v1/users/me。
func (h *UserHandler) UpdateMe(c *gin.Context) {
	var req updateProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	user, err := h.users.UpdateProfile(c.Request.Context(), middleware.UserID(c), service.ProfileUpdate{
		Nickname: req.Nickname, Email: req.Email,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toUserDTO(user))
}

type changePasswordRequest struct {
	OldPassword string `json:"oldPassword"`
	NewPassword string `json:"newPassword"`
}

// ChangePassword 处理 POST /api/v1/users/me/password。
//
// 当前刷新令牌从 Cookie 取：改密要「保留当前设备、踢掉其它设备」，
// 而服务端只能从这次请求知道哪一台是「当前设备」。
func (h *UserHandler) ChangePassword(c *gin.Context) {
	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeBadRequest, err))
		return
	}
	current := h.refreshTokenFromCookie(c)
	if err := h.auth.ChangePassword(c.Request.Context(), middleware.UserID(c), req.OldPassword, req.NewPassword, current); err != nil {
		response.Fail(c, err)
		return
	}
	response.NoContent(c)
}

// UploadAvatar 处理 POST /api/v1/users/me/avatar。
func (h *UserHandler) UploadAvatar(c *gin.Context) {
	// 用 MaxBytesReader 而不是先解析再判断大小：否则一个 1GB 的上传会先被
	// 完整读进内存/临时文件，限制就失去意义了。
	//
	// 多给的 multipartSlack 是给 boundary 与表单头留的余量：正好卡在上限的
	// 文件，加上这些框架字节也会超。落在这个余量里的文件由 service 的大小
	// 检查兜住，两条路径都回 FILE_TOO_LARGE。
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, h.maxAvatarBytes+multipartSlack)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		response.Fail(c, uploadError(err, h.maxAvatarBytes))
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		response.Fail(c, apperr.Wrap(apperr.CodeInternalError, err))
		return
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(io.LimitReader(file, h.maxAvatarBytes+1))
	if err != nil {
		response.Fail(c, uploadError(err, h.maxAvatarBytes))
		return
	}
	user, err := h.users.UpdateAvatar(c.Request.Context(), middleware.UserID(c), data)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, toUserDTO(user))
}

// multipartSlack 是 multipart 框架开销的余量。
const multipartSlack = 64 << 10

// uploadError 把读取阶段的失败翻译成对外的错误码。
//
// MaxBytesReader 超限时返回 *http.MaxBytesError，若不单独识别，用户看到的
// 会是「参数校验失败」而不是「文件过大」——前端就没法给出正确提示。
//
// 放在包级而不是某个 handler 的方法上：头像与通用图片上传共用这一套翻译，
// 各写一份必然有一处漏掉 MaxBytesError 的判断。
func uploadError(err error, maxBytes int64) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return apperr.New(apperr.CodeFileTooLarge, "").WithDetail("maxBytes", maxBytes)
	}
	if errors.Is(err, http.ErrMissingFile) {
		return apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"file": "请选择图片文件",
		})
	}
	return apperr.Wrap(apperr.CodeValidationFailed, err)
}

func (h *UserHandler) refreshTokenFromCookie(c *gin.Context) string {
	value, err := c.Cookie(h.cookieName)
	if err != nil {
		return ""
	}
	return value
}
