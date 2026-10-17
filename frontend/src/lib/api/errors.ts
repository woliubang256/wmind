export const errorMessages: Record<string, string> = {
  BAD_REQUEST: '请求格式不正确，请检查后重试。',
  AUTH_INVALID_CREDENTIALS: '账号或密码错误。',
  AUTH_TOKEN_EXPIRED: '登录状态已过期。',
  AUTH_TOKEN_INVALID: '登录状态无效，请重新登录。',
  AUTH_REFRESH_INVALID: '登录已失效，请重新登录。',
  AUTH_ACCOUNT_PENDING: '账号尚未激活，请联系管理员。',
  AUTH_ACCOUNT_DISABLED: '账号已被禁用，请联系管理员。',
  AUTH_FORBIDDEN: '你没有权限执行此操作。',
  AUTH_EMAIL_TAKEN: '该邮箱已被使用。',
  AUTH_USERNAME_TAKEN: '该用户名已被使用。',
  AUTH_TOO_MANY_ATTEMPTS: '登录尝试过多，请稍后重试。',
  REGISTRATION_CLOSED: '本站暂未开放注册。',
  MAP_LIMIT_REACHED: '已达到导图数量上限。',
  MAP_NOT_FOUND: '导图不存在或已被删除。',
  MAP_VERSION_CONFLICT: '这张导图已在其他位置修改，请选择如何处理冲突。',
  SHARE_DISABLED: '本站暂未开放分享功能。',
  SHARE_LIMIT_REACHED: '该导图的分享链接已达上限。',
  SHARE_PASSWORD_REQUIRED: '该分享需要访问密码。',
  SHARE_PASSWORD_INVALID: '访问密码不正确。',
  SHARE_NOT_FOUND: '分享链接不存在或已失效。',
  TEMPLATE_NOT_FOUND: '模板不存在。',
  TEMPLATE_BUILTIN_READONLY: '内置模板不可修改。',
  THEME_NOT_FOUND: '主题不存在。',
  THEME_BUILTIN_READONLY: '内置主题不可修改。',
  FILE_NOT_FOUND: '文件不存在或已被移除。',
  FILE_TOO_LARGE: '文件超过大小限制。',
  FILE_TYPE_NOT_ALLOWED: '不支持此文件类型。',
  DOCUMENT_TOO_LARGE: '导图文件超过大小限制。',
  DOCUMENT_INVALID: '导图数据无效或已损坏。',
  IMPORT_FORMAT_UNSUPPORTED: '不支持此导入格式。',
  IMPORT_PARSE_FAILED: '文件解析失败，请检查文件内容。',
  EXPORT_DISABLED: '本站暂未开放导出功能。',
  EXPORT_RENDER_FAILED: '导出失败，请稍后重试。',
  SETTINGS_INVALID: '设置内容无效，请检查后重试。',
  ADMIN_LAST_ADMIN: '无法移除最后一位管理员。',
  ADMIN_CANNOT_DELETE_SELF: '不能删除当前登录的管理员账号。',
  ADMIN_CANNOT_RESET_SELF: '不能通过后台重置自己的密码。',
  RATE_LIMITED: '操作过于频繁，请稍后重试。',
  MAIL_SEND_FAILED: '邮件发送失败，请稍后重试。',
  MAIL_NOT_CONFIGURED: '邮件服务尚未配置。',
  ENCRYPTION_KEY_MISSING: '服务端缺少加密配置，请联系管理员。',
  INTERNAL_ERROR: '服务器暂时无法处理请求，请稍后重试。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
  VALIDATION_FAILED: '提交的信息不符合要求。',
  RESOURCE_NOT_FOUND: '请求的内容不存在。',
};

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(envelope: ApiErrorEnvelope, status: number) {
    super(errorMessages[envelope.error.code] ?? envelope.error.message ?? '请求失败。');
    this.name = 'ApiError';
    this.code = envelope.error.code;
    this.status = status;
    this.details = envelope.error.details;
    this.requestId = envelope.requestId;
  }
}

/**
 * 取出后端返回的字段级错误（`error.details.fields`）。
 *
 * 后端把「哪个字段错了」放在这里（`WithFieldErrors`），前端把它直接铺到
 * 表单上——两条校验路径（本地先校验、后端再校验）因此共用同一套渲染。
 */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const details = error.details;
  if (typeof details !== 'object' || details === null) return {};
  const fields = (details as { fields?: unknown }).fields;
  if (typeof fields !== 'object' || fields === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** 把已知的错误码映射到具体字段，让 409 也能标红到输入框上。 */
export function codeToField(code: string): string | undefined {
  switch (code) {
    case 'AUTH_EMAIL_TAKEN':
      return 'email';
    case 'AUTH_USERNAME_TAKEN':
      return 'username';
    default:
      return undefined;
  }
}
