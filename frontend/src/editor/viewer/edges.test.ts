import { describe, expect, it } from 'vitest';
import { edgePath } from './edges';
import type { EdgePath } from '../layout/types';

function makeEdge(overrides: Partial<EdgePath> = {}): EdgePath {
  return {
    id: 'p->c',
    parentId: 'p',
    childId: 'c',
    from: { x: 100, y: 50 },
    to: { x: 200, y: 80 },
    orientation: 'h',
    lineStyle: 'curve',
    lineEnd: 'none',
    lineColor: '#000000',
    lineWidth: 2,
    ...overrides,
  };
}

describe('edgePath', () => {
  it('思维导图使用布局给出的展开控制点', () => {
    expect(edgePath(makeEdge({ curveControls: [{ x: 125, y: 40 }, { x: 180, y: 80 }] })))
      .toBe('M 100 50 C 125 40 180 80 200 80');
  });
  it('curve 用三次贝塞尔，控制点在水平中点', () => {
    expect(edgePath(makeEdge())).toBe('M 100 50 C 150 50 150 80 200 80');
  });

  it('straight 是直线', () => {
    expect(edgePath(makeEdge({ lineStyle: 'straight' }))).toBe('M 100 50 L 200 80');
  });

  it('elbow 在中点折两次', () => {
    expect(edgePath(makeEdge({ lineStyle: 'elbow' }))).toBe('M 100 50 H 150 V 80 H 200');
  });

  it('lineStyle 为 none 时返回空字符串（调用方据此跳过渲染）', () => {
    expect(edgePath(makeEdge({ lineStyle: 'none' }))).toBe('');
  });

  it('纵向连线的控制点在垂直中点（org-chart）', () => {
    expect(edgePath(makeEdge({ orientation: 'v', from: { x: 100, y: 50 }, to: { x: 160, y: 200 } }))).toBe(
      'M 100 50 C 100 125 160 125 160 200',
    );
  });

  it('纵向折线先竖后横再竖', () => {
    expect(edgePath(makeEdge({ orientation: 'v', lineStyle: 'elbow' }))).toBe('M 100 50 V 65 H 200 V 80');
  });

  it('左侧分支（to.x < from.x）同样成立', () => {
    const path = edgePath(makeEdge({
      from: { x: 200, y: 50 },
      to: { x: 100, y: 80 },
    }));
    expect(path).toBe('M 200 50 C 150 50 150 80 100 80');
  });
});
