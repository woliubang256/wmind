import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSharePassword } from './share-password';

afterEach(() => vi.unstubAllGlobals());

describe('generateSharePassword', () => {
  it('默认4位，包含大小写字母与数字，且不使用弱随机', () => {
    const weakRandom = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('weak random'); });
    try {
      const passwords = new Set(Array.from({ length: 1000 }, () => generateSharePassword()));
      expect(passwords.size).toBeGreaterThan(990);
      for (const password of passwords) {
        expect(password).toMatch(/^[A-Za-z0-9]{4}$/);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[0-9]/);
      }
    } finally { weakRandom.mockRestore(); }
  });

  it('拒绝模偏差字节和类别不全的候选', () => {
    const bytes = [255, 248, 0, 0, 0, 0, 0, 26, 52, 1];
    vi.stubGlobal('crypto', { getRandomValues: (buffer: Uint8Array) => { buffer[0] = bytes.shift() ?? 0; return buffer; } });
    expect(generateSharePassword()).toBe('aA0b');
    expect(bytes).toEqual([]);
  });

  it('安全随机不可用或失败时拒绝生成', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => generateSharePassword()).toThrow();
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('unavailable'); } });
    expect(() => generateSharePassword()).toThrow();
  });
});
