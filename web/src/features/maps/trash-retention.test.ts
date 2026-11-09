import { describe, expect, it } from 'vitest';
import { trashDaysRemaining } from './trash-retention';

describe('trashDaysRemaining', () => {
  const now = Date.parse('2026-10-24T00:00:00.500Z');
  it('向上取整到剩余天数，以服务端到期时间为准', () => {
    expect(trashDaysRemaining('2026-11-23T00:00:00.500Z', now)).toBe(30);
    expect(trashDaysRemaining('2026-10-25T00:00:00.501Z', now)).toBe(2);
    expect(trashDaysRemaining('2026-10-25T00:00:00.500Z', now)).toBe(1);
    expect(trashDaysRemaining('2026-10-24T00:00:00.501Z', now)).toBe(1);
  });
  it('到期当刻和超过期限均为即将删除', () => {
    expect(trashDaysRemaining('2026-10-24T00:00:00.500Z', now)).toBe(0);
    expect(trashDaysRemaining('2026-10-23T00:00:00Z', now)).toBe(0);
  });
  it('不同偏移量代表同一瞬间，不受本地自然日影响', () => {
    expect(trashDaysRemaining('2026-10-25T08:00:00.500+08:00', now)).toBe(1);
  });
  it('缺少或损坏时间不编造期限', () => {
    expect(trashDaysRemaining(undefined, now)).toBeNull();
    expect(trashDaysRemaining('invalid', now)).toBeNull();
  });
});
