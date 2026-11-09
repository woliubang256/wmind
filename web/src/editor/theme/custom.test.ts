import { describe, expect, it } from 'vitest';
import type { Theme } from '../model/types';
import { themeFromCustomConfig, themeSwatchColors } from './custom';
import { DEFAULT_LAYOUT, DEFAULT_PALETTE_ID, themeById } from './palettes';

const base = themeById(DEFAULT_PALETTE_ID)!;

/** 造一条「服务端存下来的」自定义主题记录。 */
function entry(config: Partial<Theme> | null, name = '我的配色') {
  return { uid: 'theme-1', name, config };
}

describe('themeFromCustomConfig', () => {
  it('身份三件套一律取记录本身，而不是 config 里的值', () => {
    // config 里写着内置配色的 id —— 这是最常见的真实情况：用户在内置配色
    // 基础上调了调就保存。原样保留会让面板把「自定义主题」和那套内置配色
    // 认成同一个，点一下自定义主题就高亮了内置那套。
    const theme = themeFromCustomConfig(entry({ id: 'classic-rainbow', name: '经典彩虹', category: 'classic' }));
    expect(theme.id).toBe('theme-1');
    expect(theme.name).toBe('我的配色');
    expect(theme.category).toBe('custom');
  });

  it('config 为 null 时整份退回默认主题', () => {
    const theme = themeFromCustomConfig(entry(null));
    expect(theme.palette.colors).toEqual(base.palette.colors);
    expect(theme.global).toEqual(base.global);
    expect(theme.layout).toEqual(DEFAULT_LAYOUT);
  });

  it('缺 palette.colors 时用默认配色兜底，不让 resolveStyle 撞上 undefined', () => {
    const theme = themeFromCustomConfig(entry({ palette: { colors: [], lineColors: [], backgroundColor: '' } }));
    expect(theme.palette.colors).toEqual(base.palette.colors);
    expect(theme.palette.lineColors).toEqual(base.palette.colors);
    expect(theme.palette.backgroundColor).toBe(base.palette.backgroundColor);
  });

  it('有 colors 但没 lineColors 时，线条色跟随填充色', () => {
    const theme = themeFromCustomConfig(
      entry({ palette: { colors: ['#112233', '#445566'], lineColors: [], backgroundColor: '#FFFFFF' } }),
    );
    expect(theme.palette.colors).toEqual(['#112233', '#445566']);
    expect(theme.palette.lineColors).toEqual(['#112233', '#445566']);
  });

  it('rainbowColors 缺失时取调色板颜色，而不是空数组', () => {
    // 空数组会让 rainbowBranch 打开后所有分支都没有颜色（resolve 里退化成
    // palette.colors[0]），看起来像「彩虹开关坏了」。
    const theme = themeFromCustomConfig(
      entry({ palette: { colors: ['#AA0000'], lineColors: ['#AA0000'], backgroundColor: '#FFFFFF' } }),
    );
    expect(theme.rainbowColors).toEqual(['#AA0000']);
  });

  it('layout 只覆盖存过的键，其余取默认值', () => {
    // 旧版本前端存的主题里没有 alignSiblings 这个键。
    const theme = themeFromCustomConfig(entry({ layout: { compact: true } as Theme['layout'] }));
    expect(theme.layout.compact).toBe(true);
    expect(theme.layout.alignSiblings).toBe(DEFAULT_LAYOUT.alignSiblings);
    expect(theme.layout.autoBalance).toBe(DEFAULT_LAYOUT.autoBalance);
  });

  it('角色样式为 null 时保留 null（「这个角色确实没有样式」与「没存过」不同）', () => {
    const theme = themeFromCustomConfig(entry({ summaryTopic: null }));
    expect(theme.summaryTopic).toBeNull();
    // 没存过的角色仍然拿底稿。
    expect(theme.boundary).toEqual(base.boundary);
  });

  it('每次返回新对象，改一份不会污染下一份', () => {
    const first = themeFromCustomConfig(entry({}));
    first.palette.colors.push('#000000');
    first.layout.compact = true;

    const second = themeFromCustomConfig(entry({}));
    expect(second.palette.colors).not.toContain('#000000');
    expect(second.layout.compact).toBe(DEFAULT_LAYOUT.compact);
  });

  it('config 里多出来的未知字段被忽略，不抛错', () => {
    const config = { ...base, someFutureField: { nested: true } } as unknown as Partial<Theme>;
    expect(() => themeFromCustomConfig(entry(config))).not.toThrow();
  });

  it('themeSwatchColors 可显示 7 色参考色板，最多给 8 段', () => {
    const theme = themeFromCustomConfig(
      entry({
        palette: {
          colors: ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9'],
          lineColors: [],
          backgroundColor: '#FFFFFF',
        },
      }),
    );
    expect(themeSwatchColors(theme)).toHaveLength(8);
  });
});
