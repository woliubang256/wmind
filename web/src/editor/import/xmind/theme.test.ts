/**
 * 主题认领与叠加的测试。
 *
 * 关键行为只有两条：**命中率高就认领内置配色**（保住校准过的对比度），
 * **命中率低就回退并提示**（不把没算过对比度的颜色塞进文档）。
 */

import { describe, expect, it } from 'vitest';
import { createImportContext } from '../context';
import { resolveLimits } from '../limits';
import { normalizeColor, matchPalette, toTheme } from './theme';

const ENTROPY = ['#FF4D6D', '#FF9F1C', '#FFD166', '#06D6A0', '#107FA4', '#7B2CBF'];

function ctxOf() {
  return createImportContext({ fileName: 'x.xmind', limits: resolveLimits() });
}

describe('normalizeColor', () => {
  it('展开三位十六进制并统一大写', () => {
    expect(normalizeColor('#fff')).toBe('#FFFFFF');
    expect(normalizeColor('#a1b2c3')).toBe('#A1B2C3');
  });

  it('rgb()/hsl() 去空白后转小写', () => {
    expect(normalizeColor('rgb(255, 0, 0)')).toBe('rgb(255,0,0)');
  });

  it('非法值返回 null', () => {
    expect(normalizeColor('red')).toBeNull();
    expect(normalizeColor('')).toBeNull();
  });
});

describe('matchPalette', () => {
  it('颜色完全一致时认领对应配色', () => {
    const match = matchPalette(ENTROPY);
    expect(match.matched).toBe(true);
    expect(match.palette.id).toBe('vivid-entropy');
    expect(match.score).toBe(1);
  });

  it('大小写与简写不影响匹配', () => {
    const match = matchPalette(ENTROPY.map((c) => c.toLowerCase()));
    expect(match.palette.id).toBe('vivid-entropy');
  });

  it('部分重合（≥50%）仍认领', () => {
    const match = matchPalette(ENTROPY.slice(0, 4));
    expect(match.matched).toBe(true);
    expect(match.palette.id).toBe('vivid-entropy');
  });

  it('几乎不重合时回退到默认配色', () => {
    const match = matchPalette(['#111111', '#222222']);
    expect(match.matched).toBe(false);
    expect(match.palette.id).toBe('vivid-dawn');
  });

  it('没有颜色时回退', () => {
    const match = matchPalette([]);
    expect(match.matched).toBe(false);
    expect(match.score).toBe(0);
    expect(match.palette.id).toBe('vivid-dawn');
  });
});

describe('toTheme', () => {
  it('非对象返回 null，让调用方沿用文档主题', () => {
    const { context } = ctxOf();
    expect(toTheme(undefined, context)).toBeNull();
    expect(toTheme('nope', context)).toBeNull();
  });

  it('命中配色时不发回退警告', () => {
    const handle = ctxOf();
    const theme = toTheme({ map: { properties: { 'multi-line-colors': ENTROPY.join(' ') } } }, handle.context);
    expect(theme?.id).toBe('vivid-entropy');
    expect(handle.warnings).toEqual([]);
  });

  it('对不上配色时回退并提示', () => {
    const handle = ctxOf();
    const theme = toTheme({ map: { properties: { 'multi-line-colors': '#111111 #222222' } } }, handle.context);
    expect(theme?.id).toBe('vivid-dawn');
    expect(handle.warnings).toEqual([{ code: 'palette-fallback' }]);
  });

  it('画布背景色覆盖配色默认值', () => {
    const handle = ctxOf();
    const theme = toTheme(
      { map: { properties: { 'multi-line-colors': ENTROPY.join(' '), 'svg:fill': '#101820' } } },
      handle.context,
    );
    expect(theme?.global.backgroundColor).toBe('#101820');
    expect(theme?.palette.backgroundColor).toBe('#101820');
  });

  it('显式角色样式叠在配色之上', () => {
    const handle = ctxOf();
    const theme = toTheme(
      {
        map: { properties: { 'multi-line-colors': ENTROPY.join(' ') } },
        centralTopic: { properties: { 'fo:font-size': '24pt', 'svg:fill': '#123456' } },
      },
      handle.context,
    );
    expect(theme?.centralTopic?.fontSize).toBe(32);
    expect(theme?.centralTopic?.fill).toBe('#123456');
  });

  it('属性直接挂在分组上（没有 properties 包一层）也认', () => {
    const handle = ctxOf();
    const theme = toTheme(
      { map: { 'multi-line-colors': ENTROPY.join(' ') }, mainTopic: { 'fo:font-size': '18pt' } },
      handle.context,
    );
    expect(theme?.mainTopic?.fontSize).toBe(24);
  });
});
