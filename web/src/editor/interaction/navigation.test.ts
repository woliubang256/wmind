import { describe, expect, it } from 'vitest';
import type { NodeBox } from '../layout/types';
import { docWithTree } from '../test-utils';
import { geometricNeighbor, structuralNeighbor } from './navigation';

/** 只造导航用得到的字段；`NodeBox` 其余字段与方向判断无关。 */
function box(id: string, centerX: number, centerY: number, width = 60, height = 30): NodeBox {
  return {
    id,
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    depth: 1,
    branchIndex: 0,
    side: 'right',
    collapsed: false,
    childCount: 0,
    hiddenChildren: 0,
  };
}

/**
 * 手工排布一张左右分叉的图（坐标即中心点）：
 *
 * ```
 *                    a1 (200,-90)
 *   a (100,-80) ────  a2 (200,-20)
 *   root (0,0)
 *   b (100,60)  ────  b1 (200,80)
 * ```
 */
function boxes(): Map<string, NodeBox> {
  const list = [
    box('root', 0, 0, 80, 30),
    box('a', 100, -80),
    box('a1', 200, -90),
    box('a2', 200, -20),
    box('b', 100, 60),
    box('b1', 200, 80),
  ];
  return new Map(list.map((item) => [item.id, item]));
}

describe('geometricNeighbor', () => {
  it('往右选同一分支上最近的节点', () => {
    // a → a1（侧向偏 10）比 a2（侧向偏 60）更接近水平方向。
    expect(geometricNeighbor(boxes(), 'a', 'right')).toBe('a1');
  });

  it('往左回到父节点，而不是更远的根', () => {
    expect(geometricNeighbor(boxes(), 'a1', 'left')).toBe('a');
  });

  it('往上下走的是同列邻接，不是自己的子节点', () => {
    // a 的下方最近的是 b（同一列），而不是斜下方的 a2。
    expect(geometricNeighbor(boxes(), 'a', 'down')).toBe('b');
    expect(geometricNeighbor(boxes(), 'b', 'up')).toBe('a');
  });

  it('根节点上下走落到分支上', () => {
    expect(geometricNeighbor(boxes(), 'root', 'up')).toBe('a');
    expect(geometricNeighbor(boxes(), 'root', 'down')).toBe('b');
  });

  it('该方向上没有节点时返回 null', () => {
    expect(geometricNeighbor(boxes(), 'b1', 'right')).toBeNull();
    expect(geometricNeighbor(boxes(), 'b1', 'down')).toBeNull();
  });

  it('起点不在布局里时返回 null', () => {
    expect(geometricNeighbor(boxes(), '不存在', 'right')).toBeNull();
  });

  it('锥形外的候选只在锥内为空时才被考虑', () => {
    // 只放一个「斜后方」的节点：往右没有任何锥内候选，
    // 此时退化到锥外挑选，而不是直接返回 null。
    const only = new Map<string, NodeBox>([
      ['from', box('from', 0, 0)],
      ['far', box('far', 10, 300)],
    ]);
    expect(geometricNeighbor(only, 'from', 'right')).toBe('far');
  });
});

describe('structuralNeighbor', () => {
  const sheet = docWithTree().sheets[0]!;

  it('父节点与第一个子节点', () => {
    expect(structuralNeighbor(sheet, 'a1', 'parent')).toBe('a');
    expect(structuralNeighbor(sheet, 'a', 'child')).toBe('a1');
    expect(structuralNeighbor(sheet, 'root', 'parent')).toBeNull();
  });

  it('折叠状态下不返回看不见的子节点', () => {
    expect(structuralNeighbor(sheet, 'a2', 'child')).toBeNull();
  });

  it('叶子节点没有子节点', () => {
    expect(structuralNeighbor(sheet, 'a1', 'child')).toBeNull();
  });

  it('兄弟跳转', () => {
    expect(structuralNeighbor(sheet, 'a1', 'next-sibling')).toBe('a2');
    expect(structuralNeighbor(sheet, 'a2', 'prev-sibling')).toBe('a1');
    expect(structuralNeighbor(sheet, 'a1', 'prev-sibling')).toBeNull();
    expect(structuralNeighbor(sheet, 'a2', 'next-sibling')).toBeNull();
  });

  it('根节点没有兄弟', () => {
    expect(structuralNeighbor(sheet, 'root', 'next-sibling')).toBeNull();
  });

  it('自由主题之间互为兄弟', () => {
    expect(structuralNeighbor(sheet, 'f1', 'next-sibling')).toBeNull();
    expect(structuralNeighbor(sheet, 'f1', 'parent')).toBeNull();
  });

  it('节点不存在时返回 null', () => {
    expect(structuralNeighbor(sheet, '不存在', 'parent')).toBeNull();
  });
});
