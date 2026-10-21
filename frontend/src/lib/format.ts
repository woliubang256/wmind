/**
 * 展示层格式化。
 *
 * 集中在一处而不是散落各页：同一个「最近登录」在用户表里用相对时间、
 * 在详情里用绝对时间，两者必须对同一个空值给出同样的占位符——分散写时
 * 总有一处漏掉 null 分支，页面上就会出现 "Invalid Date"。
 *
 * **locale 跟着界面语言走，不写死。** 这里原先是三个 `new Intl.*('zh-CN')`
 * 模块级常量：切到 en-US 后日期照旧是 `2026/10/21`，相对时间照旧是「3 分钟前」，
 * 而这一层没有任何组件能补救——调用方拿到的已经是一个拼好的字符串。
 * 改成按语言缓存格式化器：语言变了重建，同语言复用（`Intl.DateTimeFormat`
 * 构造一次约 0.1ms，每次调用都新建会拖慢长列表）。
 */

import i18n from '@/lib/i18n';

interface Formatters {
  date: Intl.DateTimeFormat;
  dateTime: Intl.DateTimeFormat;
  dayMonth: Intl.DateTimeFormat;
  number: Intl.NumberFormat;
  list: Intl.ListFormat;
}

const cache = new Map<string, Formatters>();

function formatters(): Formatters {
  const locale = i18n.language || 'zh-CN';
  const hit = cache.get(locale);
  if (hit !== undefined) return hit;
  const built: Formatters = {
    date: new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    dateTime: new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
    dayMonth: new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }),
    number: new Intl.NumberFormat(locale),
    list: new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }),
  };
  cache.set(locale, built);
  return built;
}

/** 空值占位符。全站统一用它，避免有的地方是 "-"、有的是 "暂无"。 */
export const PLACEHOLDER = '—';

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? formatters().date.format(date) : PLACEHOLDER;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? formatters().dateTime.format(date) : PLACEHOLDER;
}

/**
 * 只到「月-日」的短日期。
 *
 * 审计列表那一列用 `formatDateTime(...).slice(5, 11)` 截出来的，那是照着
 * `2026/10/21 14:19` 的固定宽度写死的——en-US 下同一串是
 * `10/21/2026, 2:19 PM`，截出来变成 `2026, `。格式化必须在 Intl 里做，
 * 不能在字符串上做。
 */
export function formatDayMonth(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? formatters().dayMonth.format(date) : PLACEHOLDER;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过一周退回绝对日期。
 *
 * 未来时间（时钟不同步、服务端写入的是 UTC 而本地时区偏西）直接显示
 * 绝对时间——「-3 分钟前」比日期更让人困惑。
 */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return PLACEHOLDER;
  const diff = now - date.getTime();
  if (diff < 0) return formatDateTime(value);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return i18n.t('format.justNow');
  if (diff < hour) return i18n.t('format.minutesAgo', { count: Math.floor(diff / minute) });
  if (diff < day) return i18n.t('format.hoursAgo', { count: Math.floor(diff / hour) });
  if (diff < 7 * day) return i18n.t('format.daysAgo', { count: Math.floor(diff / day) });
  return formatDate(value);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * 字节数转可读大小。
 *
 * 1024 进制（与后端的存储统计一致）。单位内保留一位小数，但 B 与
 * 三位数以上不留——"1023.0 B" 和 "1.5 KB" 放在一起会显得精度不一致。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? formatters().number.format(value) : PLACEHOLDER;
}

/**
 * 把一组标识拼成人话。
 *
 * 中文用顿号、英文用逗号加 and——这不该由调用方 `join('、')` 决定，
 * 那样英文界面上会出现 `avatar、email、password`。
 */
export function formatList(items: readonly string[]): string {
  if (items.length === 0) return '';
  return formatters().list.format(items);
}
