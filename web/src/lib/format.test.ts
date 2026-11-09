import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatDateTime, formatNumber, formatRelative, PLACEHOLDER } from './format';

describe('formatDate', () => {
  it('renders a date and falls back to the placeholder for empty input', () => {
    expect(formatDate('2026-10-17T08:30:00Z')).toContain('2026');
    expect(formatDate(null)).toBe(PLACEHOLDER);
    expect(formatDate('')).toBe(PLACEHOLDER);
  });

  it('does not produce "Invalid Date" for a malformed value', () => {
    expect(formatDate('not-a-date')).toBe(PLACEHOLDER);
    expect(formatDateTime('not-a-date')).toBe(PLACEHOLDER);
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');

  it('walks from "just now" up to an absolute date', () => {
    expect(formatRelative('2026-10-17T11:59:30Z', now)).toBe('刚刚');
    expect(formatRelative('2026-10-17T11:30:00Z', now)).toBe('30 分钟前');
    expect(formatRelative('2026-10-17T09:00:00Z', now)).toBe('3 小时前');
    expect(formatRelative('2026-10-15T12:00:00Z', now)).toBe('2 天前');
    // 超过一周就不再数天数了：用户关心的是「哪天」。
    expect(formatRelative('2026-09-01T12:00:00Z', now)).toContain('2026');
  });

  it('shows absolute time for timestamps in the future instead of a negative count', () => {
    const future = formatRelative('2026-10-17T12:05:00Z', now);
    expect(future).not.toContain('前');
    expect(future).toContain('2026');
  });

  it('returns the placeholder for null', () => {
    expect(formatRelative(null, now)).toBe(PLACEHOLDER);
  });
});

describe('formatBytes', () => {
  it('uses 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('drops the decimal for three-digit values so precision looks consistent', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB');
  });
});

describe('formatNumber', () => {
  it('groups thousands and rejects non-finite values', () => {
    expect(formatNumber(1234567)).toMatch(/1\D?234\D?567/);
    expect(formatNumber(Number.NaN)).toBe(PLACEHOLDER);
  });
});
