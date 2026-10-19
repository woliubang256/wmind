/**
 * 把导入结果翻译成界面文案时的**唯一**入口。
 *
 * 两个作用：
 *
 * 1. 统一拼 i18n key。界面和单测都调这里的函数，两边就不可能对不上——
 *    「测试查了 `import.warning.foo`，界面却去查 `import.warn.foo`」这类
 *    事故一次都不会发生。
 * 2. 把机器可读的参数换成人类可读的。错误里存的是字节数（`limit: 52428800`），
 *    直接插进文案会变成「上限是 52428800」。
 */

import { formatBytes } from '../../lib/format';
import type { ImportFormatId, ImportWarning, ImportWarningCode, ImportedFeature, UnsupportedFeature } from './types';

export type MessageParams = Record<string, string | number>;

/**
 * 以字节数为语义的参数名。
 *
 * 用**白名单**而不是「看着像数字就转」：`count` / `max` 也是数字，
 * 转成 "3.0 B" 就闹笑话了。
 *
 * 所以「个」类的上限一律叫 `max`（`TOO_MANY_TOPICS` / `TOO_MANY_ENTRIES`），
 * `limit` 专指字节数。混用的话「节点数超过上限（19.5 KB 个）」这种文案
 * 迟早会出现——而且只在报错时才看得见。
 */
const BYTE_PARAMS = ['size', 'limit'] as const;

export function toMessageParams(params?: MessageParams): MessageParams | undefined {
  if (!params) return undefined;
  const out: MessageParams = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'number' && (BYTE_PARAMS as readonly string[]).includes(key)
      ? formatBytes(value)
      : value;
  }
  return out;
}

export function warningKey(code: ImportWarningCode): string {
  return `import.warning.${code}`;
}

export function errorKey(code: string): string {
  return `import.error.${code}`;
}

export function unsupportedKey(feature: UnsupportedFeature): string {
  return `import.unsupported.${feature}`;
}

export function featureKey(feature: ImportedFeature): string {
  return `import.feature.${feature}`;
}

export function formatKey(format: ImportFormatId): string {
  return `import.formats.${format}`;
}

/** 警告 → `t(key, params)` 的入参。界面直接展开用。 */
export function warningMessage(warning: ImportWarning): { key: string; params: MessageParams | undefined } {
  return { key: warningKey(warning.code), params: toMessageParams(warning.params) };
}
