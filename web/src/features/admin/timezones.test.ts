import { describe, expect, it } from 'vitest';
import { TIMEZONES, timezoneOptions } from './timezones';

describe('备份时区选项', () => {
  it('固定列表包含 UTC 和各区域常用 IANA 时区', () => {
    expect(TIMEZONES[0]).toBe('UTC');
    expect(TIMEZONES.length).toBeGreaterThan(400);
    expect(TIMEZONES).toEqual(expect.arrayContaining([
      'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore',
      'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney',
    ]));
  });

  it('所有时区唯一且浏览器能用于日期格式化', () => {
    expect(new Set(TIMEZONES).size).toBe(TIMEZONES.length);
    for (const timeZone of TIMEZONES) expect(() => new Intl.DateTimeFormat('en', { timeZone })).not.toThrow();
  });

  it('保留已有别名，不改变标准列表且不重复当前值', () => {
    const alias = 'Etc/GMT-8';
    expect(timezoneOptions(alias)[0]).toEqual({ value: alias, label: alias });
    expect(TIMEZONES).not.toContain(alias);
    expect(timezoneOptions('Asia/Shanghai').filter((option) => option.value === 'Asia/Shanghai')).toHaveLength(1);
    expect(timezoneOptions('')).toHaveLength(TIMEZONES.length);
  });
});
