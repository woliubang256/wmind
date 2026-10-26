import type { AuditLogQuery } from '@/lib/api/endpoints';

export const AUDIT_PAGE_SIZE = 20;

export interface AuditFilters {
  action: string;
  from: string;
  to: string;
}

export type AuditFilterError = 'invalidDate' | 'reversedDate';
export type AuditFilterResult = { query: AuditLogQuery; error?: never } | { error: AuditFilterError; query?: never };

function localDate(raw: string, endOfDay: boolean): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split('-').map(Number);
  if (!year || !month || !day) return null;
  // setFullYear also handles years below 100; Date's numeric constructor treats them as 19xx.
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** Native date controls contain a local calendar date, never a UTC midnight. */
export function buildAuditLogQuery(filters: AuditFilters, page = 1): AuditFilterResult {
  const fromText = filters.from.trim();
  const toText = filters.to.trim();
  const from = fromText ? localDate(fromText, false) : null;
  const to = toText ? localDate(toText, true) : null;
  if ((fromText && !from) || (toText && !to)) return { error: 'invalidDate' };
  if (from && to && from.getTime() > to.getTime()) return { error: 'reversedDate' };
  return {
    query: {
      page: Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1,
      pageSize: AUDIT_PAGE_SIZE,
      ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
      ...(from ? { from: from.toISOString() } : {}),
      // The API's upper bound is inclusive and storage may retain nanoseconds.
      ...(to ? { to: to.toISOString().replace('.999Z', '.999999999Z') } : {}),
    },
  };
}
