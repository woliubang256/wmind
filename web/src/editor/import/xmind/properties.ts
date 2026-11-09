/**
 * 读 XMind 属性袋的底层工具。
 *
 * XMind 的 `properties` 是 `Record<string, string>` 的**名义**结构，实际会出现
 * 三种形态：纯字符串、数字、以及 `{ type, value }` 包一层的对象。同一个
 * `svg:fill` 在不同文件里可能是 `"#FFF"` 也可能是 `{"type":"color","value":"#FFF"}`，
 * 不统一收口就会出现「有些文件读得出颜色、有些读不出」这种极难排查的差异。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type Properties = Record<string, unknown>;

/** 读原始字符串。读不到返回 undefined（与「读到了空串」区分开）。 */
export function read(properties: Properties, key: string): string | undefined {
  const value = properties[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (isRecord(value) && typeof value.value === 'string') return value.value;
  return undefined;
}

/** 与 `model/validate.ts` 的 isColor 同构；不共用是因为那边没导出。 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla)\([^)]*\)$/;

export function isColorValue(value: string): boolean {
  return HEX_COLOR.test(value) || FUNC_COLOR.test(value);
}

/**
 * 读颜色。三种结果都有意义：
 * - `undefined` = 没这个属性 → 不写进样式（继承）；
 * - `null` = XMind 明确写了 `none` → 无填充 / 无边框；
 * - 字符串 = 有效颜色。
 */
export function readColor(properties: Properties, key: string): string | null | undefined {
  const raw = read(properties, key);
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'none') return null;
  if (isColorValue(value)) return value;
  return undefined;
}

/**
 * 读字号：XMind 用 `pt`，本项目用 `px`。
 *
 * 不换算的话 XMind 默认的 `24pt` 中心主题会变成 24px，比本项目默认的 30px
 * 明显小一圈——导入结果「看起来不像原来那张图」。1pt = 4/3 px。
 */
export function readPx(properties: Properties, key: string): number | undefined {
  const raw = read(properties, key);
  if (raw === undefined) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)\s*(pt|px)?$/i.exec(raw.trim());
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? 'px').toLowerCase();
  return Math.round(unit === 'pt' ? (value * 4) / 3 : value);
}

export function readNumber(properties: Properties, key: string): number | undefined {
  const raw = read(properties, key);
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** 读枚举。`aliases` 用于「XMind 的值和我们的值不同名」的情况。 */
export function readEnum<T extends string>(
  properties: Properties,
  key: string,
  allowed: readonly T[],
  aliases: Record<string, T> = {},
): T | undefined {
  const raw = read(properties, key);
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  const alias = aliases[value];
  if (alias !== undefined) return alias;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
