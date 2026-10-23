import { beforeEach, describe, expect, it } from 'vitest';
import { clearStyleCache, computeStyle, resolveStyle } from './resolve';
import type { StyleContext } from './resolve';
import { defaultTheme } from '../model/create';
import { docWithTree } from '../test-utils';
import { findTopic } from '../model/traverse';
import type { Theme } from '../model/types';

const theme = defaultTheme();

function ctxOf(id: string, overrides: Partial<StyleContext> = {}): StyleContext {
  const found = findTopic(docWithTree(), id)!;
  return {
    depth: found.depth,
    branchIndex: found.branchIndex,
    isRoot: found.depth === 0,
    isFloating: found.isFloating,
    isSummary: false,
    ...overrides,
  };
}

function styleOf(id: string, t: Theme = theme, overrides: Partial<StyleContext> = {}) {
  const found = findTopic(docWithTree(), id)!;
  return computeStyle(found.topic, ctxOf(id, overrides), t);
}

beforeEach(() => {
  clearStyleCache();
});

describe('解析顺序', () => {
  it('根节点用 centralTopic，且不被调色板覆盖', () => {
    const style = styleOf('root');
    expect(style.fill).toBe('#7EA9C0');
    expect(style.fontSize).toBe(24);
    expect(style.fontWeight).toBe(700);
    expect(style.rainbowBranch).toBe(false); // 根没有分支序号
  });

  it('一级分支按 branchIndex 取调色板颜色', () => {
    expect(styleOf('a').fill).toBe('#EB8589');
    expect(styleOf('b').fill).toBe('#E9B07E');
  });

  it('二级及以下继承分支序号，但保留 subTopic 的显式白色填充', () => {
    const a1 = styleOf('a1');
    expect(a1.fill).toBe('#FFFFFF'); // subTopic 显式指定
    expect(a1.lineColor).toBe('#EB8589'); // 未被指定 → 取分支色
  });

  it('theme.global 提供字体、字号与线宽', () => {
    const custom: Theme = {
      ...theme,
      global: { ...theme.global, fontFamily: 'serif', fontSize: 18, lineWidth: 5 },
    };
    const style = styleOf('a1', custom);
    // fontFamily 没有任何角色样式指定，所以能落到 global 上。
    expect(style.fontFamily).toBe('serif');
    // fontSize / lineWidth 在 subTopic 里显式写了，角色样式优先于 global ——
    // 这是解析链的定义，不是 bug：global 是「角色没指定时的默认值」。
    expect(style.fontSize).toBe(14);
    expect(style.lineWidth).toBe(2);
  });

  it('角色样式为空时 global 的字号生效', () => {
    const custom: Theme = {
      ...theme,
      global: { ...theme.global, fontSize: 18 },
      subTopic: null,
    };
    expect(styleOf('a1', custom).fontSize).toBe(18);
  });

  it('自由主题用 floatingTopic 且不取调色板', () => {
    const style = styleOf('f1');
    expect(style.fill).toBe('#FFF8E1');
    expect(style.borderColor).toBe('#FFB300');
  });

  it('关闭彩虹分支后所有分支用同一个颜色（开关必须真的有效）', () => {
    const custom: Theme = {
      ...theme,
      rainbowBranch: false,
      palette: { colors: ['#111111', '#222222'], lineColors: ['#333333', '#444444'], backgroundColor: '#FFF' },
      rainbowColors: ['#AAAAAA', '#BBBBBB'],
    };
    expect(styleOf('a', custom).fill).toBe('#111111');
    expect(styleOf('b', custom).fill).toBe('#111111');
    expect(styleOf('a', custom).lineColor).toBe('#333333');
    expect(styleOf('b', custom).lineColor).toBe('#333333');
  });

  it('彩虹序列为空时回落到配色方案', () => {
    const custom: Theme = {
      ...theme,
      rainbowBranch: true,
      palette: { colors: ['#111111', '#222222'], lineColors: ['#333333'], backgroundColor: '#FFF' },
      rainbowColors: [],
    };
    expect(styleOf('a', custom).fill).toBe('#111111');
    expect(styleOf('b', custom).fill).toBe('#222222');
  });

  it('分支序号超出色板长度时取模循环', () => {
    const custom: Theme = {
      ...theme,
      rainbowBranch: true,
      palette: { colors: ['#111111', '#222222'], lineColors: ['#333333'], backgroundColor: '#FFF' },
      rainbowColors: ['#111111', '#222222'],
    };
    const a = findTopic(docWithTree(), 'a')!.topic;
    const style = (branchIndex: number) =>
      computeStyle(a, { ...ctxOf('a'), branchIndex }, custom).fill;
    expect(style(0)).toBe('#111111');
    expect(style(1)).toBe('#222222');
    expect(style(2)).toBe('#111111');
    expect(style(7)).toBe('#222222');
  });
});

describe('节点级样式覆盖', () => {
  it('topic.style 的显式字段最后生效', () => {
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    a.style = { fill: '#000000', fontSize: 30 };

    const style = computeStyle(a, ctxOf('a'), theme);
    expect(style.fill).toBe('#000000');
    expect(style.fontSize).toBe(30);
    // 未指定的字段仍来自角色样式
    expect(style.textColor).toBe('#FFFFFF');
  });

  it('fill 显式设为 null 表示无填充，不被调色板顶掉', () => {
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    a.style = { fill: null };

    expect(computeStyle(a, ctxOf('a'), theme).fill).toBeNull();
  });

  it('节点级 rainbowBranch 可以推翻主题设置', () => {
    const custom: Theme = { ...theme, rainbowBranch: false };
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    a.style = { rainbowBranch: true };

    expect(computeStyle(a, ctxOf('a'), custom).rainbowBranch).toBe(true);
  });
});

describe('缓存', () => {
  it('相同输入返回同一引用', () => {
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    const first = resolveStyle(a, ctxOf('a'), theme);
    const second = resolveStyle(a, ctxOf('a'), theme);
    expect(second).toBe(first);
  });

  it('样式变化后不复用旧结果', () => {
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    const before = resolveStyle(a, ctxOf('a'), theme);
    a.style = { ...a.style, fill: '#123456' };
    const after = resolveStyle(a, ctxOf('a'), theme);
    expect(after).not.toBe(before);
    expect(after.fill).toBe('#123456');
  });

  it('上下文变化（分支序号）后不复用旧结果', () => {
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    const first = resolveStyle(a, ctxOf('a'), theme);
    const shifted = resolveStyle(a, { ...ctxOf('a'), branchIndex: 1 }, theme);
    expect(shifted.fill).not.toBe(first.fill);
  });
});
