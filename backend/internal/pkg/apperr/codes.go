package apperr

import "net/http"

// Code 是稳定的错误标识。
//
// 前端据此做文案映射，**不要依赖 Message 做判断**（它可能被本地化，也可能改动）。
// 因此 Code 一经发布即为契约，改名等同于破坏 API。
type Code string

// 一期错误码。与 docs/04-后端设计与API规范.md §6 的错误码表一一对应。
const (
	CodeBadRequest Code = "BAD_REQUEST"

	CodeAuthTwoFactorInvalid   Code = "AUTH_2FA_INVALID"
	CodeAuthTwoFactorExpired   Code = "AUTH_2FA_EXPIRED"
	CodeAuthTwoFactorState     Code = "AUTH_2FA_STATE"
	CodeAuthInvalidCredentials Code = "AUTH_INVALID_CREDENTIALS"
	CodeAuthTokenExpired       Code = "AUTH_TOKEN_EXPIRED"
	CodeAuthTokenInvalid       Code = "AUTH_TOKEN_INVALID"
	CodeAuthRefreshInvalid     Code = "AUTH_REFRESH_INVALID"
	CodeSharePasswordRequired  Code = "SHARE_PASSWORD_REQUIRED"
	CodeSharePasswordInvalid   Code = "SHARE_PASSWORD_INVALID"

	CodeAuthAccountDisabled     Code = "AUTH_ACCOUNT_DISABLED"
	CodeAuthForbidden           Code = "AUTH_FORBIDDEN"
	CodeRegistrationClosed      Code = "REGISTRATION_CLOSED"
	CodeMapLimitReached         Code = "MAP_LIMIT_REACHED"
	CodeShareDisabled           Code = "SHARE_DISABLED"
	CodeShareLimitReached       Code = "SHARE_LIMIT_REACHED"
	CodeTemplateBuiltinReadonly Code = "TEMPLATE_BUILTIN_READONLY"
	CodeTemplateLimitReached    Code = "TEMPLATE_LIMIT_REACHED"
	CodeTemplateDisabled        Code = "TEMPLATE_DISABLED"
	CodeThemeBuiltinReadonly    Code = "THEME_BUILTIN_READONLY"
	CodeThemeLimitReached       Code = "THEME_LIMIT_REACHED"
	CodeExportDisabled          Code = "EXPORT_DISABLED"

	CodeResourceNotFound Code = "RESOURCE_NOT_FOUND"
	CodeMapNotFound      Code = "MAP_NOT_FOUND"
	CodeShareNotFound    Code = "SHARE_NOT_FOUND"
	CodeTemplateNotFound Code = "TEMPLATE_NOT_FOUND"
	CodeThemeNotFound    Code = "THEME_NOT_FOUND"
	CodeFileNotFound     Code = "FILE_NOT_FOUND"

	CodeAuthEmailTaken        Code = "AUTH_EMAIL_TAKEN"
	CodeAuthUsernameTaken     Code = "AUTH_USERNAME_TAKEN"
	CodeMapVersionConflict    Code = "MAP_VERSION_CONFLICT"
	CodeAdminLastAdmin        Code = "ADMIN_LAST_ADMIN"
	CodeAdminCannotDeleteSelf Code = "ADMIN_CANNOT_DELETE_SELF"
	CodeAdminCannotResetSelf  Code = "ADMIN_CANNOT_RESET_SELF"

	CodeDocumentTooLarge Code = "DOCUMENT_TOO_LARGE"
	CodeFileTooLarge     Code = "FILE_TOO_LARGE"

	CodeFileTypeNotAllowed      Code = "FILE_TYPE_NOT_ALLOWED"
	CodeImportFormatUnsupported Code = "IMPORT_FORMAT_UNSUPPORTED"

	CodeValidationFailed  Code = "VALIDATION_FAILED"
	CodeDocumentInvalid   Code = "DOCUMENT_INVALID"
	CodeImportParseFailed Code = "IMPORT_PARSE_FAILED"
	CodeSettingsInvalid   Code = "SETTINGS_INVALID"

	CodeAuthTooManyAttempts Code = "AUTH_TOO_MANY_ATTEMPTS"
	CodeRateLimited         Code = "RATE_LIMITED"

	CodeInternalError      Code = "INTERNAL_ERROR"
	CodeExportRenderFailed Code = "EXPORT_RENDER_FAILED"
	CodeServiceUnavailable Code = "SERVICE_UNAVAILABLE"
)

// 二期邮件能力预留的错误码。
//
// 一期不返回这些错误，但**现在就把编码固定下来**：错误码是 API 契约，
// 二期再插入会打乱已发布的编号，也会让前端的文案映射表被迫返工。
const (
	CodeAuthAccountPending   Code = "AUTH_ACCOUNT_PENDING"
	CodeMailSendFailed       Code = "MAIL_SEND_FAILED"
	CodeMailNotConfigured    Code = "MAIL_NOT_CONFIGURED"
	CodeEncryptionKeyMissing Code = "ENCRYPTION_KEY_MISSING"
)

// spec 是每个错误码的 HTTP 状态与默认中文文案。
type spec struct {
	status  int
	message string
}

var registry = map[Code]spec{
	CodeBadRequest:           {http.StatusBadRequest, "请求体格式错误"},
	CodeAuthTwoFactorInvalid: {http.StatusUnprocessableEntity, "验证码无效、已使用或已过期"},
	CodeAuthTwoFactorExpired: {http.StatusUnprocessableEntity, "验证已过期，请重新开始"},
	CodeAuthTwoFactorState:   {http.StatusConflict, "双因素认证状态已改变，请刷新后重试"},

	CodeAuthInvalidCredentials: {http.StatusUnauthorized, "账号或密码错误"},
	CodeAuthTokenExpired:       {http.StatusUnauthorized, "登录状态已过期"},
	CodeAuthTokenInvalid:       {http.StatusUnauthorized, "令牌无效"},
	CodeAuthRefreshInvalid:     {http.StatusUnauthorized, "登录状态已失效，请重新登录"},
	CodeSharePasswordRequired:  {http.StatusUnauthorized, "该分享需要访问密码"},
	CodeSharePasswordInvalid:   {http.StatusUnauthorized, "访问密码错误"},

	CodeAuthAccountDisabled:     {http.StatusForbidden, "账号已被禁用"},
	CodeAuthForbidden:           {http.StatusForbidden, "无权限访问"},
	CodeRegistrationClosed:      {http.StatusForbidden, "站点已关闭注册"},
	CodeMapLimitReached:         {http.StatusForbidden, "已达导图数量上限"},
	CodeShareDisabled:           {http.StatusForbidden, "站点已关闭分享功能"},
	CodeShareLimitReached:       {http.StatusForbidden, "该导图的分享链接数量已达上限"},
	CodeTemplateBuiltinReadonly: {http.StatusForbidden, "内置模板不可修改"},
	CodeTemplateLimitReached:    {http.StatusForbidden, "模板数量已达上限"},
	CodeTemplateDisabled:        {http.StatusForbidden, "站点已关闭用户模板"},
	CodeThemeBuiltinReadonly:    {http.StatusForbidden, "内置主题不可修改"},
	CodeThemeLimitReached:       {http.StatusForbidden, "自定义主题数量已达上限"},
	CodeExportDisabled:          {http.StatusForbidden, "站点已关闭导出"},

	CodeResourceNotFound: {http.StatusNotFound, "资源不存在"},
	CodeMapNotFound:      {http.StatusNotFound, "导图不存在或无权访问"},
	CodeShareNotFound:    {http.StatusNotFound, "分享不存在或已失效"},
	CodeTemplateNotFound: {http.StatusNotFound, "模板不存在"},
	CodeThemeNotFound:    {http.StatusNotFound, "主题不存在"},
	CodeFileNotFound:     {http.StatusNotFound, "文件不存在"},

	CodeAuthEmailTaken:        {http.StatusConflict, "邮箱已被占用"},
	CodeAuthUsernameTaken:     {http.StatusConflict, "用户名已被占用"},
	CodeMapVersionConflict:    {http.StatusConflict, "该导图已在其他位置被修改"},
	CodeAdminLastAdmin:        {http.StatusConflict, "不能降级或删除最后一个管理员"},
	CodeAdminCannotDeleteSelf: {http.StatusConflict, "不能删除自己"},
	CodeAdminCannotResetSelf:  {http.StatusConflict, "不能通过后台重置自己的密码"},

	CodeDocumentTooLarge: {http.StatusRequestEntityTooLarge, "导图文档超过大小上限"},
	CodeFileTooLarge:     {http.StatusRequestEntityTooLarge, "文件超过大小上限"},

	CodeFileTypeNotAllowed:      {http.StatusUnsupportedMediaType, "文件类型不允许"},
	CodeImportFormatUnsupported: {http.StatusUnsupportedMediaType, "导入格式不支持"},

	CodeValidationFailed:  {http.StatusUnprocessableEntity, "参数校验失败"},
	CodeDocumentInvalid:   {http.StatusUnprocessableEntity, "导图文档结构非法"},
	CodeImportParseFailed: {http.StatusUnprocessableEntity, "导入文件解析失败"},
	CodeSettingsInvalid:   {http.StatusUnprocessableEntity, "设置项非法"},

	CodeAuthTooManyAttempts: {http.StatusTooManyRequests, "登录尝试过多，请稍后再试"},
	CodeRateLimited:         {http.StatusTooManyRequests, "请求过于频繁，请稍后再试"},

	CodeInternalError:      {http.StatusInternalServerError, "服务器内部错误"},
	CodeExportRenderFailed: {http.StatusInternalServerError, "导出渲染失败"},
	CodeServiceUnavailable: {http.StatusServiceUnavailable, "依赖服务不可用"},

	// 二期
	CodeAuthAccountPending:   {http.StatusForbidden, "账号待激活，请先完成邮箱验证"},
	CodeMailSendFailed:       {http.StatusBadGateway, "邮件发送失败"},
	CodeMailNotConfigured:    {http.StatusServiceUnavailable, "邮件服务未启用或未配置"},
	CodeEncryptionKeyMissing: {http.StatusServiceUnavailable, "未配置加密密钥，无法保存敏感配置"},
}

// lookup 返回错误码对应的规格。未登记的码按内部错误处理——宁可返回 500
// 也不要凭空造一个 4xx 出去。
func lookup(code Code) spec {
	if s, ok := registry[code]; ok {
		return s
	}
	return registry[CodeInternalError]
}
