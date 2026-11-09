import { describe, expect, it, vi } from 'vitest';
import {
  applyResolvedTheme,
  isThemePreference,
  nextThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from './theme';

describe('theme preference', () => {
  it('falls back to system when nothing is stored', () => {
    expect(readThemePreference({ getItem: () => null })).toBe('system');
  });

  it('ignores unknown stored values instead of trusting them', () => {
    // 手改 localStorage 或旧版本残留都可能写入任意字符串；
    // 直接当 class 名用会得到一个既不是 light 也不是 dark 的状态。
    expect(readThemePreference({ getItem: () => 'solarized' })).toBe('system');
    expect(isThemePreference('solarized')).toBe(false);
  });

  it('reads a stored preference', () => {
    const getItem = vi.fn((key: string) => (key === THEME_STORAGE_KEY ? 'dark' : null));
    expect(readThemePreference({ getItem })).toBe('dark');
    expect(getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  });

  it('resolves system against the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    // 显式档位不受系统影响。
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('cycles light → dark → system', () => {
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
    expect(nextThemePreference('system')).toBe('light');
  });

  it('toggles the html class and theme-color meta', () => {
    const classes = new Set<string>();
    const root = {
      classList: {
        toggle: (token: string, force?: boolean) => {
          if (force) classes.add(token);
          else classes.delete(token);
        },
      },
    };
    const meta = { content: '', setAttribute: (_name: string, value: string) => { meta.content = value; } };

    applyResolvedTheme('dark', root, meta);
    expect(classes.has('dark')).toBe(true);
    expect(meta.content).toBe(THEME_COLORS.dark);

    applyResolvedTheme('light', root, meta);
    expect(classes.has('dark')).toBe(false);
    expect(meta.content).toBe(THEME_COLORS.light);
  });

  it('tolerates a missing theme-color meta tag', () => {
    const root = { classList: { toggle: vi.fn() } };
    expect(() => applyResolvedTheme('dark', root, null)).not.toThrow();
  });
});
