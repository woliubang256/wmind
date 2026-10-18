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
    lineStyle: 'curve',
    lineEnd: 'none',
    lineColor: '#000000',
    lineWidth: 2,
    ...overrides,
  };
}

describe('edgePath', () => {
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

  it('左侧分支（to.x < from.x）同样成立', () => {
    const path = edgePath(makeEdge({
      from: { x: 200, y: 50 },
      to: { x: 100, y: 80 },
    }));
    expect(path).toBe('M 200 50 C 150 50 150 80 100 80');
  });
});
