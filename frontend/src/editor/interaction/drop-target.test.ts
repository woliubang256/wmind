import { describe, expect, it } from 'vitest';
import type { NodeBox } from '../layout/types';
import { docWithTree } from '../test-utils';
import { boxesInRect, nearestBox, resolveDrop } from './drop-target';

function box(id: string, x: number, y: number, width = 60, height = 30): NodeBox {
  return {
    id,
    x,
    y,
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
 * 与 `docWithTree()` 对应的几何（左上角坐标）：
 *
 * ```
 *              a1(200,-90)   a2(200,-20)
 *   root(0,0)
 *              b(100,60)     b1(200,80)
 * ```
 *
 * `a2x` 因为 `a2` 折叠而不在布局里。
 */
function boxes(): Map<string, NodeBox> {
  const list = [
    box('root', 0, 0, 80, 30),
    box('a', 100, -80),
    box('a1', 200, -90),
    box('a2', 200, -20),
    box('b', 100, 60),
    box('b1', 200, 80),
    box('f1', 0, 200),
  ];
  return new Map(list.map((item) => [item.id, item]));
}

const sheet = () => docWithTree().sheets[0]!;

/** 盒子中心。 */
function center(id: string): { x: number; y: number } {
  const b = boxes().get(id)!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

describe('nearestBox', () => {
  it('点在盒子内距离为 0', () => {
    const found = nearestBox(boxes(), center('b'), new Set());
    expect(found?.box.id).toBe('b');
    expect(found?.distance).toBe(0);
  });

  it('排除被拖的节点', () => {
    const found = nearestBox(boxes(), center('b'), new Set(['b']));
    expect(found?.box.id).not.toBe('b');
  });
});

describe('resolveDrop', () => {
  it('落在中心区域 = 成为子节点', () => {
    const drop = resolveDrop(boxes(), sheet(), ['a1'], center('b'));
    expect(drop?.mode).toBe('child');
    expect(drop?.parentId).toBe('b');
    expect(drop?.valid).toBe(true);
  });

  it('落在上沿 = 插到它前面', () => {
    const b = boxes().get('b')!;
    const drop = resolveDrop(boxes(), sheet(), ['a1'], { x: b.x + 5, y: b.y + 2 });
    expect(drop?.mode).toBe('before');
    expect(drop?.parentId).toBe('root');
    // root 的子节点是 [a, b]，b 的下标是 1。
    expect(drop?.index).toBe(1);
  });

  it('落在下沿 = 插到它后面，且下标要扣掉自己', () => {
    const b = boxes().get('b')!;
    const drop = resolveDrop(boxes(), sheet(), ['a'], { x: b.x + 5, y: b.y + b.height - 2 });
    expect(drop?.mode).toBe('after');
    expect(drop?.parentId).toBe('root');
    // 目标 b 在下标 1，插入位是 2；但 a 自己（下标 0）也在同一个父节点下，
    // 摘掉它之后 b 落到 0，所以最终插入位是 1，结果 [b, a]。
    // 不扣这一位就会插到 2 变成越界追加，看起来像「拖到 b 后面却跑到了末尾」。
    expect(drop?.index).toBe(1);
  });

  it('拖到自己的后代上被拒绝', () => {
    const drop = resolveDrop(boxes(), sheet(), ['a'], center('a1'));
    expect(drop?.valid).toBe(false);
    expect(drop?.reason).toBe('descendant');
  });

  it('中心主题不能移动', () => {
    const drop = resolveDrop(boxes(), sheet(), ['root'], center('b'));
    expect(drop?.valid).toBe(false);
    expect(drop?.reason).toBe('root');
  });

  it('自由主题不能作为父节点', () => {
    const drop = resolveDrop(boxes(), sheet(), ['a1'], center('f1'));
    expect(drop?.valid).toBe(false);
    expect(drop?.reason).toBe('floating-target');
  });

  it('根节点没有兄弟：落在它的上沿也当成子节点', () => {
    const root = boxes().get('root')!;
    const drop = resolveDrop(boxes(), sheet(), ['b1'], { x: root.x + 5, y: root.y + 1 });
    expect(drop?.mode).toBe('child');
    expect(drop?.parentId).toBe('root');
  });

  it('拖到远处空白 = 转为自由主题', () => {
    const drop = resolveDrop(boxes(), sheet(), ['a1'], { x: 900, y: 900 });
    expect(drop?.mode).toBe('detach');
    expect(drop?.valid).toBe(true);
  });

  it('自由主题拖到空白什么都不发生', () => {
    expect(resolveDrop(boxes(), sheet(), ['f1'], { x: 900, y: 900 })).toBeNull();
  });

  it('拖回原位是合法但无需执行的落点', () => {
    const a2 = boxes().get('a2')!;
    // a1 已经在 a2 前面，再插一次还是同一个位置。
    const drop = resolveDrop(boxes(), sheet(), ['a1'], { x: a2.x + 5, y: a2.y + 2 });
    expect(drop?.valid).toBe(true);
    expect(drop?.noop).toBe(true);
  });

  it('多选拖拽按整组算下标', () => {
    const b = boxes().get('b')!;
    const drop = resolveDrop(boxes(), sheet(), ['a1', 'b1'], { x: b.x + 5, y: b.y + b.height - 2 });
    expect(drop?.valid).toBe(true);
    expect(drop?.parentId).toBe('root');
    // 两个被拖节点都不在 root 下，不需要扣位。
    expect(drop?.index).toBe(2);
  });
});

describe('boxesInRect', () => {
  it('相交即选中，不要求完全包含', () => {
    // 一条横线扫过 a1 与 a2 的左边缘。
    const ids = boxesInRect(boxes(), { x: 195, y: -100, width: 10, height: 100 });
    expect(ids.sort()).toEqual(['a1', 'a2']);
  });

  it('反向拖出的矩形也能用', () => {
    const ids = boxesInRect(boxes(), { x: 205, y: 10, width: -10, height: -110 });
    expect(ids.sort()).toEqual(['a1', 'a2']);
  });

  it('空白处返回空数组', () => {
    expect(boxesInRect(boxes(), { x: 900, y: 900, width: 20, height: 20 })).toEqual([]);
  });
});
