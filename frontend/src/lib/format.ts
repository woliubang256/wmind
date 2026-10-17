/**
 * 展示层格式化。
 *
 * 集中在一处而不是散落各页：同一个「最近登录」在用户表里用相对时间、
 * 在详情里用绝对时间，两者必须对同一个空值给出同样的占位符——分散写时
 * 总有一处漏掉 null 分支，页面上就会出现 "Invalid Date"。
 */

const DATE = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const NUMBER = new Intl.NumberFormat('zh-CN');

/** 空值占位符。全站统一用它，避免有的地方是 "-"、有的是 "暂无"。 */
export const PLACEHOLDER = '—';

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? DATE.format(date) : PLACEHOLDER;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? DATE_TIME.format(date) : PLACEHOLDER;
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
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
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
  return Number.isFinite(value) ? NUMBER.format(value) : PLACEHOLDER;
}
