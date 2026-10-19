import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PALETTES,
  PALETTE_IDS,
  applyPalette,
  paletteById,
  paletteOrDefault,
  themeById,
  themeFromPalette,
} from './palettes';
import { computeStyle } from './resolve';
import { createTopic, defaultTheme } from '../model/create';

const BRANCH = { depth: 1, isRoot: false, isFloating: false, isSummary: false };

function styleOfBranch(paletteId: string, branchIndex: number) {
  const theme = themeById(paletteId);
  const topic = createTopic({ title: 'x' });
  return computeStyle(topic, { ...BRANCH, branchIndex }, theme);
}

/** 与 scripts/check-palette-contrast.mjs 相同的对比度计算，用于独立复核。 */
function luminance(color: string): number {
  const full = color.slice(1);
  const channel = (offset: number): number => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('内置配色数据', () => {
  it('共 10 套，缤纷 5 套 + 经典 5 套', () => {
    expect(BUILTIN_PALETTES).toHaveLength(10);
    expect(BUILTIN_PALETTES.filter((p) => p.category === 'vivid')).toHaveLength(5);
    expect(BUILTIN_PALETTES.filter((p) => p.category === 'classic')).toHaveLength(5);
  });

  it('id 与 docs/03 §6.2 一致且不重复', () => {
    expect(new Set(PALETTE_IDS).size).toBe(10);
    expect(PALETTE_IDS).toEqual([
      'vivid-entropy',
      'vivid-vitality',
      'vivid-code',
      'vivid-island',
      'vivid-mint',
      'classic-rainbow',
      'classic-dance',
      'classic-breeze',
      'classic-rose',
      'classic-greentea',
    ]);
  });

  it('每套 6 个分支色，线条色与填充色等长', () => {
    for (const palette of BUILTIN_PALETTES) {
      expect(palette.colors, palette.id).toHaveLength(6);
      expect(palette.lineColors, palette.id).toHaveLength(6);
    }
  });

  it('色值均为大写 #RRGGBB', () => {
    for (const palette of BUILTIN_PALETTES) {
      for (const color of [...palette.colors, ...palette.lineColors, palette.centralTopic.fill]) {
        expect(color, palette.id).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });
});

describe('对比度（验收标准 5）', () => {
  it('每个分支色上自动选出的文字色都 ≥ 4.5:1', () => {
    for (const palette of BUILTIN_PALETTES) {
      for (let index = 0; index < palette.colors.length; index += 1) {
        const style = styleOfBranch(palette.id, index);
        const value = ratio(style.fill as string, style.textColor);
        expect(value, `${palette.id} colors[${index}] ${style.fill} / ${style.textColor}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('中心主题的文字色也 ≥ 4.5:1', () => {
    for (const palette of BUILTIN_PALETTES) {
      const theme = themeById(palette.id);
      const style = computeStyle(
        createTopic({ title: 'root' }),
        { ...BRANCH, depth: 0, isRoot: true, branchIndex: -1 },
        theme,
      );
      expect(ratio(style.fill as string, style.textColor), palette.id).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('配色 → 主题', () => {
  it('分支填充与中心主题随配色变化', () => {
    const rainbow = styleOfBranch('classic-rainbow', 0);
    const mint = styleOfBranch('vivid-mint', 0);
    expect(rainbow.fill).not.toBe(mint.fill);
    expect(themeById('classic-rainbow').centralTopic?.fill)
      .not.toBe(themeById('vivid-mint').centralTopic?.fill);
  });

  it('每套配色都产出完整的 Theme 骨架', () => {
    for (const palette of BUILTIN_PALETTES) {
      const theme = themeFromPalette(palette);
      expect(theme.id, palette.id).toBe(palette.id);
      expect(theme.floatingTopic?.fill, palette.id).toBe('#FFF8E1');
      expect(theme.boundary?.borderStyle, palette.id).toBe('dash');
      expect(theme.layout.autoBalance, palette.id).toBe(true);
      // 彩虹序列默认跟随配色，否则换配色后线条还是上一套的颜色
      expect(theme.rainbowColors, palette.id).toEqual(palette.colors);
    }
  });

  it('返回的是新对象，改一份不会污染内置数据', () => {
    const first = themeById('classic-rainbow');
    first.palette.colors[0] = '#000000';
    expect(themeById('classic-rainbow').palette.colors[0]).not.toBe('#000000');
    expect(paletteById('classic-rainbow')?.colors[0]).not.toBe('#000000');
  });

  it('未知 id 回落到默认配色', () => {
    expect(paletteOrDefault('nope').id).toBe('classic-rainbow');
    expect(paletteOrDefault(null).id).toBe('classic-rainbow');
  });
});

describe('换配色时保留用户的画布设置', () => {
  it('全局字体、字号、线宽、背景与布局开关不被冲掉', () => {
    const current = defaultTheme();
    current.global.fontFamily = 'serif';
    current.global.fontSize = 18;
    current.global.lineWidth = 3;
    current.global.backgroundColor = '#FAFAFA';
    current.layout.compact = true;
    current.rainbowBranch = false;

    const next = applyPalette(current, paletteById('vivid-island')!);

    expect(next.id).toBe('vivid-island');
    expect(next.global.fontFamily).toBe('serif');
    expect(next.global.fontSize).toBe(18);
    expect(next.global.lineWidth).toBe(3);
    expect(next.global.backgroundColor).toBe('#FAFAFA');
    expect(next.palette.backgroundColor).toBe('#FAFAFA');
    expect(next.layout.compact).toBe(true);
    expect(next.rainbowBranch).toBe(false);
    // 配色相关的部分确实换了
    expect(next.palette.colors).toEqual(paletteById('vivid-island')!.colors);
  });
});
