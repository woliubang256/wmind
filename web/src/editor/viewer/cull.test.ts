import { describe, expect, it } from 'vitest';
import type { EdgePath, NodeBox, Rect } from '../layout/types';
import { CULL_THRESHOLD, cullBoxes, cullEdges, expandRect, intersects } from './cull';

function box(id: string, x: number, y: number, width = 100, height = 40): NodeBox {
  return { id, x, y, width, height, depth: 1, branchIndex: 0, side: 'right', collapsed: false, childCount: 0, hiddenChildren: 0 };
}

function edge(id: string, from: [number, number], to: [number, number]): EdgePath {
  return {
    id,
    parentId: 'p',
    childId: 'c',
    from: { x: from[0], y: from[1] },
    to: { x: to[0], y: to[1] },
    orientation: 'h',
    lineStyle: 'curve',
    lineEnd: 'none',
    lineColor: '#000000',
    lineWidth: 2,
  };
}

const viewport: Rect = { x: 0, y: 0, width: 800, height: 600 };

describe('intersects', () => {
  it('相交、包含、相离三种关系', () => {
    expect(intersects({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
    expect(intersects({ x: 10, y: 10, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 })).toBe(true);
    expect(intersects({ x: 200, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 })).toBe(false);
  });

  it('只贴边不算相交（边界上的零面积交集）', () => {
    expect(intersects({ x: 100, y: 0, width: 50, height: 50 }, { x: 0, y: 0, width: 100, height: 100 })).toBe(false);
  });
});

describe('expandRect', () => {
  it('四周都放大，且不小于固定下限', () => {
    const expanded = expandRect({ x: 0, y: 0, width: 100, height: 100 });
    // 100 * 0.5 = 50 < 240，取固定下限
    expect(expanded).toEqual({ x: -240, y: -240, width: 100 + 480, height: 100 + 480 });
  });

  it('视口很大时按比例放大', () => {
    const expanded = expandRect({ x: 0, y: 0, width: 2000, height: 2000 });
    expect(expanded.x).toBe(-1000);
    expect(expanded.width).toBe(4000);
  });

  it('原点不在 0 也正确', () => {
    const expanded = expandRect({ x: -500, y: -500, width: 100, height: 100 });
    expect(expanded.x).toBe(-740);
    expect(expanded.y).toBe(-740);
  });
});

describe('cullBoxes', () => {
  it('只有形状下方标签进入视口时仍保留主题', () => {
    const item = { ...box('labels', 0, -400), outerHeight: 300 };
    expect(cullBoxes([item], viewport).map((entry) => entry.id)).toEqual(['labels']);
  });

  it('rect 为 null 时原样返回（导出与小图走这条路）', () => {
    const boxes = [box('a', 0, 0), box('b', 99999, 99999)];
    expect(cullBoxes(boxes, null)).toHaveLength(2);
  });

  it('视口内的留下，远处的丢掉', () => {
    const boxes = [box('near', 100, 100), box('far', 20000, 20000)];
    const kept = cullBoxes(boxes, viewport).map((item) => item.id);
    expect(kept).toEqual(['near']);
  });

  it('余量内的节点仍保留（快速拖动不会露出空白）', () => {
    // 视口 800×600，余量取 max(800*0.5, 240)=400 / max(600*0.5,240)=300
    const justOutside = box('edge', 800 + 390, 100, 20, 20);
    const beyond = box('beyond', 800 + 400 + 10, 100, 20, 20);
    const kept = cullBoxes([justOutside, beyond], viewport).map((item) => item.id);
    expect(kept).toEqual(['edge']);
  });

  it('keep 里的节点无条件保留，哪怕在视口外', () => {
    // 选中的节点被裁掉的话，aria-activedescendant 会指向不存在的 id，
    // 读屏会静默失声——这不是性能问题，是可用性问题。
    const selected = box('selected', 20000, 20000);
    const kept = cullBoxes([box('near', 0, 0), selected], viewport, new Set(['selected']));
    expect(kept.map((item) => item.id)).toEqual(['near', 'selected']);
  });

  it('保留顺序与输入一致（渲染顺序不能乱）', () => {
    const boxes = [box('c', 300, 300), box('a', 100, 100), box('b', 200, 200)];
    expect(cullBoxes(boxes, viewport).map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('cullEdges', () => {
  it('rect 为 null 时原样返回', () => {
    const edges = [edge('e1', [0, 0], [100, 0])];
    expect(cullEdges(edges, null)).toHaveLength(1);
  });

  it('两端都在视口外的长线只要穿过视口就保留', () => {
    // 从左外侧穿到右外侧，包围盒与视口相交
    const spanning = edge('span', [-2000, 300], [2000, 300]);
    expect(cullEdges([spanning], viewport).map((item) => item.id)).toEqual(['span']);
  });

  it('远处的连线被丢掉', () => {
    const far = edge('far', [20000, 20000], [20100, 20000]);
    expect(cullEdges([far], viewport)).toHaveLength(0);
  });
});

describe('CULL_THRESHOLD', () => {
  it('阈值足够大，普通导图不会触发裁剪', () => {
    // 一次全量 diff 几百个节点仍在 10ms 以内，裁剪反而多一次遍历。
    expect(CULL_THRESHOLD).toBeGreaterThanOrEqual(200);
  });
});
