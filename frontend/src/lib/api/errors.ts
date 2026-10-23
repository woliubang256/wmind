import i18n from '@/lib/i18n';

/**
 * 错误码 → 语言包里的 key。
 *
 * 值不再是中文字面量：这一层拿不到 React 上下文（`ApiError` 在请求层构造，
 * 可能在任意事件回调里），所以走 i18next 的单例 `t`。切换语言之后**新发生**
 * 的错误会跟着换语言；已经抛出来的那条保持原样——错误提示是瞬时的，为它
 * 记住语言再重渲染一遍不值得。
 *
 * 码本身是后端契约（docs/04 §3.2），不翻译；只有给人看的那句话翻译。
 */
export const errorMessageKeys: Record<string, string> = {
  AUTH_2FA_INVALID: 'errors.AUTH_2FA_INVALID',
  AUTH_2FA_EXPIRED: 'errors.AUTH_2FA_EXPIRED',
  AUTH_2FA_STATE: 'errors.AUTH_2FA_STATE',
  BAD_REQUEST: 'errors.BAD_REQUEST',
  AUTH_INVALID_CREDENTIALS: 'errors.AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'errors.AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'errors.AUTH_TOKEN_INVALID',
  AUTH_REFRESH_INVALID: 'errors.AUTH_REFRESH_INVALID',
  AUTH_ACCOUNT_PENDING: 'errors.AUTH_ACCOUNT_PENDING',
  AUTH_ACCOUNT_DISABLED: 'errors.AUTH_ACCOUNT_DISABLED',
  AUTH_FORBIDDEN: 'errors.AUTH_FORBIDDEN',
  AUTH_EMAIL_TAKEN: 'errors.AUTH_EMAIL_TAKEN',
  AUTH_USERNAME_TAKEN: 'errors.AUTH_USERNAME_TAKEN',
  AUTH_TOO_MANY_ATTEMPTS: 'errors.AUTH_TOO_MANY_ATTEMPTS',
  REGISTRATION_CLOSED: 'errors.REGISTRATION_CLOSED',
  MAP_LIMIT_REACHED: 'errors.MAP_LIMIT_REACHED',
  MAP_NOT_FOUND: 'errors.MAP_NOT_FOUND',
  MAP_VERSION_CONFLICT: 'errors.MAP_VERSION_CONFLICT',
  SHARE_DISABLED: 'errors.SHARE_DISABLED',
  SHARE_LIMIT_REACHED: 'errors.SHARE_LIMIT_REACHED',
  SHARE_PASSWORD_REQUIRED: 'errors.SHARE_PASSWORD_REQUIRED',
  SHARE_PASSWORD_INVALID: 'errors.SHARE_PASSWORD_INVALID',
  SHARE_NOT_FOUND: 'errors.SHARE_NOT_FOUND',
  TEMPLATE_NOT_FOUND: 'errors.TEMPLATE_NOT_FOUND',
  TEMPLATE_BUILTIN_READONLY: 'errors.TEMPLATE_BUILTIN_READONLY',
  THEME_NOT_FOUND: 'errors.THEME_NOT_FOUND',
  THEME_BUILTIN_READONLY: 'errors.THEME_BUILTIN_READONLY',
  THEME_LIMIT_REACHED: 'errors.THEME_LIMIT_REACHED',
  FILE_NOT_FOUND: 'errors.FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'errors.FILE_TOO_LARGE',
  FILE_TYPE_NOT_ALLOWED: 'errors.FILE_TYPE_NOT_ALLOWED',
  DOCUMENT_TOO_LARGE: 'errors.DOCUMENT_TOO_LARGE',
  DOCUMENT_INVALID: 'errors.DOCUMENT_INVALID',
  IMPORT_FORMAT_UNSUPPORTED: 'errors.IMPORT_FORMAT_UNSUPPORTED',
  IMPORT_PARSE_FAILED: 'errors.IMPORT_PARSE_FAILED',
  EXPORT_DISABLED: 'errors.EXPORT_DISABLED',
  EXPORT_RENDER_FAILED: 'errors.EXPORT_RENDER_FAILED',
  SETTINGS_INVALID: 'errors.SETTINGS_INVALID',
  ADMIN_LAST_ADMIN: 'errors.ADMIN_LAST_ADMIN',
  ADMIN_CANNOT_DELETE_SELF: 'errors.ADMIN_CANNOT_DELETE_SELF',
  ADMIN_CANNOT_RESET_SELF: 'errors.ADMIN_CANNOT_RESET_SELF',
  RATE_LIMITED: 'errors.RATE_LIMITED',
  MAIL_SEND_FAILED: 'errors.MAIL_SEND_FAILED',
  MAIL_NOT_CONFIGURED: 'errors.MAIL_NOT_CONFIGURED',
  ENCRYPTION_KEY_MISSING: 'errors.ENCRYPTION_KEY_MISSING',
  INTERNAL_ERROR: 'errors.INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'errors.SERVICE_UNAVAILABLE',
  VALIDATION_FAILED: 'errors.VALIDATION_FAILED',
  RESOURCE_NOT_FOUND: 'errors.RESOURCE_NOT_FOUND',
};

/**
 * 挑一条给人看的错误文案。
 *
 * 三级兜底：认识的码用本地文案 → 后端自己给的 `message` → 通用的「请求失败」。
 *
 * 注意 i18next 找不到 key 时**返回 key 本身**（配置里 `returnNull: false`），
 * 所以不能拿 `t()` 的返回值当「有没有翻译」用，必须比对一次。这一条踩过：
 * 少写一个 key 时界面上会直接显示 `errors.SOMETHING`。
 */
export function resolveErrorMessage(code: string, fallback: string | undefined): string {
  const key = errorMessageKeys[code];
  if (key !== undefined) {
    const translated = i18n.t(key);
    if (translated !== key) return translated;
  }
  if (fallback !== undefined && fallback !== '') return fallback;
  return i18n.t('errors.unknown');
}

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
    super(resolveErrorMessage(envelope.error.code, envelope.error.message));
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
