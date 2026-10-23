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
import { createDocument, createTopic, defaultTheme } from '../model/create';
import { parseDocument } from '../model/validate';

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
  it('参考目录共 19 套，缤纷 10 套 + 经典 9 套', () => {
    expect(BUILTIN_PALETTES).toHaveLength(19);
    expect(BUILTIN_PALETTES.filter((p) => p.category === 'vivid')).toHaveLength(10);
    expect(BUILTIN_PALETTES.filter((p) => p.category === 'classic')).toHaveLength(9);
  });

  it('id 与 docs/03 §6.2 一致且不重复', () => {
    expect(new Set(PALETTE_IDS).size).toBe(19);
    expect(PALETTE_IDS).toEqual([
      'vivid-dawn',
      'classic-rainbow',
      'vivid-vitality',
      'classic-dance',
      'vivid-code',
      'vivid-kimono',
      'vivid-island',
      'classic-rose',
      'vivid-mint',
      'classic-greentea',
      'classic-constancy',
      'classic-cream',
      'classic-flowers',
      'classic-coral',
      'classic-gorgeous',
      'classic-champagne',
      'classic-perfume',
      'classic-zen',
      'classic-groove',
    ]);
  });

  it('每套保留自己的分支色数量，线条色与填充色等长', () => {
    for (const palette of BUILTIN_PALETTES) {
      expect(palette.colors.length, palette.id).toBeGreaterThanOrEqual(6);
      expect(palette.lineColors, palette.id).toHaveLength(palette.colors.length);
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
  it('参考色板的浅色主题在白色画布上仍有可见连线', () => {
    for (const palette of BUILTIN_PALETTES) {
      for (let index = 0; index < palette.colors.length; index += 1) {
        const style = styleOfBranch(palette.id, index);
        expect(ratio(style.lineColor, palette.backgroundColor), `${palette.id} lineColors[${index}]`)
          .toBeGreaterThanOrEqual(1.5);
      }
    }
  });

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
  it('分支填充随配色变化，参考色板的中心使用白底深色字', () => {
    const rainbow = styleOfBranch('classic-rainbow', 0);
    const mint = styleOfBranch('vivid-mint', 0);
    expect(rainbow.fill).not.toBe(mint.fill);
    expect(themeById('vivid-dawn').centralTopic?.fill).toBe('#FFFFFF');
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
    expect(paletteOrDefault('nope').id).toBe('vivid-dawn');
    expect(paletteOrDefault(null).id).toBe('vivid-dawn');
  });

  it('旧高熵、和风仍可按 ID 读取，但不出现在新目录', () => {
    for (const id of ['vivid-entropy', 'classic-breeze']) {
      expect(paletteById(id)?.id).toBe(id);
      expect(PALETTE_IDS).not.toContain(id);
    }
  });

  it('保存的旧主题按完整内容解析，不按同名内置 ID 替换', () => {
    const doc = createDocument();
    const oldColors = ['#EB8589', '#E9B07E', '#DCCD8C', '#96BFA7', '#8BB9CE', '#B5A0CB'];
    doc.theme = {
      ...doc.theme, id: 'classic-rainbow',
      palette: { ...doc.theme.palette, colors: oldColors, lineColors: [...oldColors] },
      rainbowColors: [...oldColors],
      centralTopic: { ...doc.theme.centralTopic, fill: '#7EA9C0', borderColor: '#7EA9C0' },
    };
    doc.sheets[0]!.rootTopic.style = { fill: '#456A86' };
    const restored = parseDocument(JSON.parse(JSON.stringify(doc))).document;
    expect(restored.theme).toEqual(doc.theme);
    expect(restored.sheets[0]!.rootTopic.style).toEqual({ fill: '#456A86' });
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
