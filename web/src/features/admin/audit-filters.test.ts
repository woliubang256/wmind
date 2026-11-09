import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuditLogQuery } from './audit-filters';

afterEach(() => vi.unstubAllEnvs());

describe('操作日志筛选', () => {
  it('默认查询保留固定页长，清空筛选回到第一页', () => {
    expect(buildAuditLogQuery({ action: '', from: '', to: '' })).toEqual({
      query: { page: 1, pageSize: 20 },
    });
    expect(buildAuditLogQuery({ action: ' ', from: ' ', to: ' ' }, 3)).toEqual({
      query: { page: 3, pageSize: 20 },
    });
  });

  it('亚洲时区按本地整天生成包含末纳秒的UTC边界', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    expect(buildAuditLogQuery({ action: 'share.create', from: '2026-10-25', to: '2026-10-26' })).toEqual({
      query: {
        page: 1, pageSize: 20, action: 'share.create',
        from: '2026-10-24T16:00:00.000Z', to: '2026-10-26T15:59:59.999999999Z',
      },
    });
  });

  it('夏令时切换日按当地日界线换算，不假设每天24小时', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(buildAuditLogQuery({ action: '', from: '2026-03-08', to: '2026-03-08' })).toEqual({
      query: {
        page: 1, pageSize: 20,
        from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T03:59:59.999999999Z',
      },
    });
  });

  it('支持只有一个日期边界，以及闰年日期', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(buildAuditLogQuery({ action: '', from: '2024-02-29', to: '' })).toEqual({
      query: { page: 1, pageSize: 20, from: '2024-02-29T00:00:00.000Z' },
    });
    expect(buildAuditLogQuery({ action: '', from: '', to: '2026-10-26' })).toEqual({
      query: { page: 1, pageSize: 20, to: '2026-10-26T23:59:59.999999999Z' },
    });
  });

  it('拒绝非法或被Date自动溢出的日期，不返回可发送的查询', () => {
    for (const date of ['bad', '2026-2-3', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-01-32', '0000-01-01']) {
      expect(buildAuditLogQuery({ action: '', from: date, to: '' })).toEqual({ error: 'invalidDate' });
      expect(buildAuditLogQuery({ action: '', from: '', to: date })).toEqual({ error: 'invalidDate' });
    }
  });

  it('拒绝逆序日期，重新筛选不沿用旧页码', () => {
    expect(buildAuditLogQuery({ action: '', from: '2026-10-27', to: '2026-10-26' })).toEqual({ error: 'reversedDate' });
    expect(buildAuditLogQuery({ action: 'settings.update', from: '', to: '' })).toEqual({
      query: { page: 1, pageSize: 20, action: 'settings.update' },
    });
  });

  it('非法页码归一为第一页，正数页码取整数', () => {
    for (const page of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildAuditLogQuery({ action: '', from: '', to: '' }, page)).toEqual({ query: { page: 1, pageSize: 20 } });
    }
    expect(buildAuditLogQuery({ action: '', from: '', to: '' }, 2.9)).toEqual({ query: { page: 2, pageSize: 20 } });
  });
});
