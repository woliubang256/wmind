/**
 * 表单校验。
 *
 * 手写而不是引入 zod：这里只有四条规则（长度、格式、必填、一致性），
 * 而 zod 会给首屏 bundle 增加 ~13KB。校验结果统一是 `Record<string, string>`
 * ——与后端的 `error.details.fields` 同形，所以「前端先校验、后端再校验」
 * 两条路径可以共用同一套渲染逻辑。
 *
 * 规则与后端保持一致（backend/internal/service/auth.go 的 validateRegistration）。
 * 两边漂移的症状是「前端放过、后端 422」，用户看到一个没标红的错误。
 *
 * 文案走 i18next 单例而不是 `useTranslation()`：这里是纯函数，在事件处理器里
 * 被调用，没有 React 上下文可拿。与 `lib/api/errors.ts` 同一个做法。
 */

import i18n from '@/lib/i18n';

/** 用户名：3–32 位字母、数字、下划线或短横线。 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
/** 邮箱：只做基本形态校验，真正的判定交给后端。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const NICKNAME_MAX_RUNES = 32;
/** 与后端 auth.MaxPasswordBytes 一致：bcrypt 会静默截断超过 72 字节的部分。 */
export const PASSWORD_MAX_BYTES = 72;

export type FieldErrors = Record<string, string>;

export function validateUsername(value: string): string | undefined {
  if (!value.trim()) return i18n.t('validate.usernameRequired');
  if (!USERNAME_PATTERN.test(value.trim())) return i18n.t('validate.usernameFormat');
  return undefined;
}

export function validateEmail(value: string): string | undefined {
  if (!value.trim()) return i18n.t('validate.emailRequired');
  if (!EMAIL_PATTERN.test(value.trim())) return i18n.t('validate.emailFormat');
  return undefined;
}

export function validateNickname(value: string): string | undefined {
  // 按字符数而不是字节数：中文昵称按字节算会被错误地判为超长。
  if ([...value.trim()].length > NICKNAME_MAX_RUNES) return i18n.t('validate.nicknameTooLong', { max: NICKNAME_MAX_RUNES });
  return undefined;
}

export function validatePassword(value: string, minLength: number): string | undefined {
  if (!value) return i18n.t('validate.passwordRequired');
  if ([...value].length < minLength) return i18n.t('validate.passwordTooShort', { min: minLength });
  if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) return i18n.t('validate.passwordTooLong', { max: PASSWORD_MAX_BYTES });
  return undefined;
}

/** 校验注册表单。 */
export function validateRegistration(
  input: { username: string; email: string; password: string; nickname: string },
  minPasswordLength: number,
): FieldErrors {
  const errors: FieldErrors = {};
  const username = validateUsername(input.username);
  if (username) errors.username = username;
  const email = validateEmail(input.email);
  if (email) errors.email = email;
  const password = validatePassword(input.password, minPasswordLength);
  if (password) errors.password = password;
  const nickname = validateNickname(input.nickname);
  if (nickname) errors.nickname = nickname;
  return errors;
}

/** 校验改密表单。 */
export function validatePasswordChange(
  input: { oldPassword: string; newPassword: string; confirmPassword: string },
  minPasswordLength: number,
): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.oldPassword) errors.oldPassword = i18n.t('validate.oldPasswordRequired');
  const next = validatePassword(input.newPassword, minPasswordLength);
  if (next) errors.newPassword = next;
  if (input.newPassword && input.confirmPassword !== input.newPassword) {
    errors.confirmPassword = i18n.t('validate.passwordMismatch');
  }
  if (input.newPassword && input.oldPassword && input.newPassword === input.oldPassword) {
    errors.newPassword = i18n.t('validate.passwordSame');
  }
  return errors;
}

/** 校验个人资料表单。 */
export function validateProfile(input: { nickname: string; email: string }): FieldErrors {
  const errors: FieldErrors = {};
  const nickname = validateNickname(input.nickname);
  if (nickname) errors.nickname = nickname;
  const email = validateEmail(input.email);
  if (email) errors.email = email;
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
