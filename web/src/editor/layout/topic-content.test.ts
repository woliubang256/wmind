import { describe, expect, it } from 'vitest';
import { topicContentGeometry } from './topic-content';
import { NODE_METRICS } from './constants';
import type { ComputedStyle } from '../model/types';
import type { NodeBox } from './types';

/**
 * 文字在主题框里必须**水平与垂直都居中**（除非用户显式改成左/右对齐）。
 *
 * 回归点：编辑态输入框原来只在主题带标记/备注时才用「文字矩形」，普通主题
 * 退回「盒子左上角 + 内边距」，编辑时文字看起来没居中——这里的几何是两条
 * 路径的共同依据，先把它钉住。
 */

function style(overrides: Partial<ComputedStyle> = {}): ComputedStyle {
  return {
    fontSize: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    textDecoration: 'none',
    textColor: '#000',
    textAlign: 'center',
    fontFamily: 'sans',
    ...overrides,
  } as ComputedStyle;
}

function box(overrides: Partial<NodeBox> = {}): NodeBox {
  return { id: 'root', x: 100, y: 50, width: 200, height: 90, collapsed: false, ...overrides } as NodeBox;
}

describe('topicContentGeometry', () => {
  it('单行文字在框内垂直居中', () => {
    const geometry = topicContentGeometry(box(), style(), ['Topic'], null);
    const lineHeight = Math.round(16 * NODE_METRICS.lineHeightRatio);
    const expectedTop = 50 + (90 - lineHeight) / 2;
    expect(geometry.textRect.y).toBeCloseTo(expectedTop, 5);
    // firstY 是「基线中心」：文字矩形顶 + 半行高。
    expect(geometry.firstY).toBeCloseTo(expectedTop + lineHeight / 2, 5);
  });

  it('居中对齐时文字矩形左右对称', () => {
    const geometry = topicContentGeometry(box(), style(), ['Topic'], null);
    const leftGap = geometry.textRect.x - 100;
    const rightGap = 100 + 200 - (geometry.textRect.x + geometry.textRect.width);
    expect(leftGap).toBeCloseTo(rightGap, 5);
    expect(geometry.textAnchor).toBe('middle');
  });

  it('多行文字整体居中（而不是贴着顶部）', () => {
    const geometry = topicContentGeometry(box(), style(), ['a', 'b', 'c'], null);
    const lineHeight = Math.round(16 * NODE_METRICS.lineHeightRatio);
    const textHeight = lineHeight * 3;
    expect(geometry.textRect.height).toBeCloseTo(textHeight, 5);
    expect(geometry.textRect.y).toBeCloseTo(50 + (90 - textHeight) / 2, 5);
  });

  it('左对齐时文字贴着内边距，垂直仍然居中', () => {
    const geometry = topicContentGeometry(box(), style({ textAlign: 'left' }), ['Topic'], null);
    expect(geometry.textRect.x).toBeCloseTo(100 + NODE_METRICS.paddingX, 5);
    expect(geometry.textAnchor).toBe('start');
    const lineHeight = Math.round(16 * NODE_METRICS.lineHeightRatio);
    expect(geometry.textRect.y).toBeCloseTo(50 + (90 - lineHeight) / 2, 5);
  });
});
