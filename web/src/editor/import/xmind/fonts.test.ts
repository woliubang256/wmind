/**
 * 字体名归一的测试（docs/03 §5.3.1，验收项 IE-25）。
 *
 * 表里的每一行都对应文档中的一条规则。最要紧的两条是「不残留原始字体名」
 * 与「sans-serif 不能变成衬线」——后者是子串匹配的经典陷阱。
 */

import { describe, expect, it } from 'vitest';
import type { FontFamily } from '../../model/types';
import { cleanFontName, normalizeFontFamily } from './fonts';

const CASES: Array<[string, FontFamily, boolean]> = [
  // [输入, 期望族, 是否降级]
  ['NeverMind', 'sans', false],
  ['Source Han Sans SC', 'sans', false],
  ['Noto Sans SC', 'sans', false],
  ['思源黑体', 'sans', false],
  ['PingFang SC', 'sans', false],
  ['苹方-简', 'sans', false],
  ['Hiragino Sans GB', 'sans', false],
  ['Microsoft YaHei', 'sans', false],
  ['微软雅黑', 'sans', false],
  ['DengXian', 'sans', false],
  ['等线', 'sans', false],
  ['SimHei', 'sans', false],
  ['黑体', 'sans', false],
  ['Helvetica Neue', 'sans', false],
  ['Arial', 'sans', false],
  ['Roboto', 'sans', false],
  ['Segoe UI', 'sans', false],
  ['system-ui', 'sans', false],

  ['Source Han Serif SC', 'serif', false],
  ['Noto Serif SC', 'serif', false],
  ['思源宋体', 'serif', false],
  ['SimSun', 'serif', false],
  ['宋体', 'serif', false],
  ['Songti SC', 'serif', false],
  ['Times New Roman', 'serif', false],
  ['Georgia', 'serif', false],
  ['serif', 'serif', false],

  ['KaiTi', 'serif', true],
  ['楷体', 'serif', true],
  ['STKaiti', 'serif', true],
  ['LXGW WenKai', 'serif', true],
  ['霞鹜文楷', 'serif', true],

  ['Consolas', 'mono', false],
  ['Courier New', 'mono', false],
  ['Monaco', 'mono', false],
  ['Menlo', 'mono', false],
  ['JetBrains Mono', 'mono', false],
  ['monospace', 'mono', false],
];

describe('归一映射表', () => {
  for (const [input, family, degraded] of CASES) {
    it(`${input} → ${family}${degraded ? '（降级）' : ''}`, () => {
      const result = normalizeFontFamily(input);
      expect(result).toEqual({ family, known: true, degraded });
    });
  }
});

describe('子串匹配的顺序陷阱', () => {
  it('sans-serif 不会被当成衬线', () => {
    // 'serif' 是 'sans-serif' 的子串。规则顺序错了，所有无衬线字体会变衬线。
    expect(normalizeFontFamily('sans-serif')?.family).toBe('sans');
    expect(normalizeFontFamily('Sans-Serif')?.family).toBe('sans');
    expect(normalizeFontFamily('"Noto Sans SC", sans-serif')?.family).toBe('sans');
  });

  it('Noto Serif 不会被 Noto Sans 规则吃掉', () => {
    expect(normalizeFontFamily('Noto Serif SC')?.family).toBe('serif');
  });

  it('楷体优先于宋体规则（STKaiti 同时含两者语义）', () => {
    // STKaiti 命中 kaiti 规则，应带降级标记而不是普通的 serif。
    expect(normalizeFontFamily('STKaiti')?.degraded).toBe(true);
  });
});

describe('未知与空值', () => {
  it('不认识的字体回退 sans 且标记 known=false', () => {
    expect(normalizeFontFamily('Comic Sans MS')).toEqual({
      family: 'sans',
      known: false,
      degraded: false,
    });
  });

  it('大小写不敏感', () => {
    expect(normalizeFontFamily('CONSOLAS')?.family).toBe('mono');
    expect(normalizeFontFamily('nevermind')?.family).toBe('sans');
  });

  it('undefined 返回 null（表示继承，不该写进样式）', () => {
    expect(normalizeFontFamily(undefined)).toBeNull();
  });

  it('空串与纯空白返回 null', () => {
    expect(normalizeFontFamily('')).toBeNull();
    expect(normalizeFontFamily('   ')).toBeNull();
    expect(normalizeFontFamily('""')).toBeNull();
  });
});

describe('cleanFontName', () => {
  it('去掉包裹的引号', () => {
    expect(cleanFontName("'PingFang SC'")).toBe('PingFang SC');
    expect(cleanFontName('"Microsoft YaHei"')).toBe('Microsoft YaHei');
  });

  it('去掉首尾空白', () => {
    expect(cleanFontName('  Arial  ')).toBe('Arial');
  });
});
