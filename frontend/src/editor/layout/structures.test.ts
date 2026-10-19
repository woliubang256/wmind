import { describe, expect, it } from 'vitest';
import { layoutMindmap } from './mindmap';
import { docWithTree } from '../test-utils';
import { defaultTheme } from '../model/create';
import type { NodeBox } from './types';
import type { StructureClass, Topic } from '../model/types';

/**
 * 其余结构（M2.7）：logic-right / logic-left / tree-right / org-chart。
 *
 * 每个结构都断言「几何方向」而不是具体坐标：坐标随测量与间距变化，
 * 而「子节点在父节点右侧」是结构的定义。
 */

const stubMeasure = (topic: Topic) => ({ width: 100, height: 40, lines: [topic.title] });

function layout(structure: StructureClass) {
  const doc = docWithTree();
  const sheet = doc.sheets[0]!;
  sheet.structure = structure;
  return layoutMindmap({ sheet, theme: defaultTheme(), measure: stubMeasure });
}

type Result = ReturnType<typeof layout>;

function box(result: Result, id: string): NodeBox {
  const found = result.boxes.get(id);
  if (!found) throw new Error(`缺少节点 ${id}`);
  return found;
}

const center = (b: NodeBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

describe('logic-right', () => {
  it('所有一级分支都在右侧，没有左侧分支', () => {
    const result = layout('logic-right');
    const root = box(result, 'root');
    for (const id of ['a', 'b', 'a1', 'a2', 'b1']) {
      expect(box(result, id).side).toBe('right');
      expect(box(result, id).x).toBeGreaterThan(root.x + root.width);
    }
    expect(root.side).toBe('none');
  });

  it('每一层的子节点都在父节点右侧，且连线端点落在两侧边缘', () => {
    const result = layout('logic-right');
    for (const edge of result.edges) {
      expect(edge.orientation).toBe('h');
      expect(edge.to.x).toBeGreaterThan(edge.from.x);
      const parent = box(result, edge.parentId);
      const child = box(result, edge.childId);
      expect(edge.from.x).toBe(parent.x + parent.width);
      expect(edge.to.x).toBe(child.x);
    }
  });

  it('同层节点垂直不重叠', () => {
    const result = layout('logic-right');
    const a = box(result, 'a');
    const b = box(result, 'b');
    expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  });
});

describe('logic-left', () => {
  it('镜像：所有分支在左侧', () => {
    const result = layout('logic-left');
    const root = box(result, 'root');
    for (const id of ['a', 'b', 'a1', 'a2', 'b1']) {
      expect(box(result, id).side).toBe('left');
      expect(box(result, id).x + box(result, id).width).toBeLessThan(root.x);
    }
  });

  it('连线从左边缘伸出，端点落在子节点右边缘', () => {
    const result = layout('logic-left');
    // 自由主题永远按横向向右排布，不受主结构方向影响。
    const treeEdges = result.edges.filter((edge) => !edge.parentId.startsWith('f'));
    expect(treeEdges.length).toBeGreaterThan(0);
    for (const edge of treeEdges) {
      expect(edge.to.x).toBeLessThan(edge.from.x);
      const parent = box(result, edge.parentId);
      const child = box(result, edge.childId);
      expect(edge.from.x).toBe(parent.x);
      expect(edge.to.x).toBe(child.x + child.width);
    }
  });
});

describe('tree-right', () => {
  it('几何与 logic-right 相同', () => {
    const right = layout('logic-right');
    const tree = layout('tree-right');
    for (const id of ['root', 'a', 'b', 'a1', 'a2', 'b1']) {
      expect(tree.boxes.get(id)).toEqual(right.boxes.get(id));
    }
  });

  it('只有连线样式变成折线', () => {
    const result = layout('tree-right');
    expect(result.edges.length).toBeGreaterThan(0);
    for (const edge of result.edges) {
      expect(edge.lineStyle).toBe('elbow');
    }
  });
});

describe('org-chart', () => {
  it('子节点在父节点下方，side 为 bottom', () => {
    const result = layout('org-chart');
    const root = box(result, 'root');
    expect(root.side).toBe('none');
    for (const id of ['a', 'b', 'a1', 'a2', 'b1']) {
      const found = box(result, id);
      expect(found.side).toBe('bottom');
      expect(found.y).toBeGreaterThan(root.y + root.height);
    }
  });

  it('父节点水平居中于首尾子节点中心的中点', () => {
    const result = layout('org-chart');
    const root = box(result, 'root');
    const a = box(result, 'a');
    const b = box(result, 'b');
    expect(Math.abs(center(root).x - (center(a).x + center(b).x) / 2)).toBeLessThan(1);

    // 二级同理：a 在 a1 / a2 之间。
    const a1 = box(result, 'a1');
    const a2 = box(result, 'a2');
    expect(Math.abs(center(a).x - (center(a1).x + center(a2).x) / 2)).toBeLessThan(1);
  });

  it('只有一个子节点时父子中心对齐（连线是竖直的直线）', () => {
    const doc = docWithTree();
    const sheet = doc.sheets[0]!;
    sheet.structure = 'org-chart';
    // b 只有一个子节点 b1。
    const result = layoutMindmap({ sheet, theme: defaultTheme(), measure: stubMeasure });
    expect(Math.abs(center(box(result, 'b')).x - center(box(result, 'b1')).x)).toBeLessThan(1);
  });

  it('连线是纵向的，从父节点下沿到子节点上沿', () => {
    const result = layout('org-chart');
    // 自由主题永远按横向排布，即使主结构是纵向的。
    const floating = new Set(['f1', 'f1x']);
    const treeEdges = result.edges.filter((edge) => !floating.has(edge.parentId));
    // root→a、root→b、a→a1、a→a2、b→b1（a2 折叠，所以没有 a2→a2x）。
    expect(treeEdges.length).toBe(5);
    for (const edge of treeEdges) {
      expect(edge.orientation).toBe('v');
      const parent = box(result, edge.parentId);
      const child = box(result, edge.childId);
      expect(edge.from.y).toBe(parent.y + parent.height);
      expect(edge.to.y).toBe(child.y);
      expect(edge.from.x).toBe(parent.x + parent.width / 2);
      expect(edge.to.x).toBe(child.x + child.width / 2);
      expect(edge.to.y).toBeGreaterThan(edge.from.y);
    }
  });

  it('同层兄弟水平不重叠', () => {
    const result = layout('org-chart');
    const a = box(result, 'a');
    const b = box(result, 'b');
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x).toBe(true);
  });

  it('包围盒容得下所有节点', () => {
    const result = layout('org-chart');
    for (const b of result.boxes.values()) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(result.bounds.width);
      expect(b.y + b.height).toBeLessThanOrEqual(result.bounds.height);
    }
  });
});

/** 任意两个节点都不重叠。验收标准 4 的硬要求。 */
function assertNoOverlap(result: Result): void {
  const boxes = [...result.boxes.values()];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlap =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      expect(overlap, `${a.id} 与 ${b.id} 重叠`).toBe(false);
    }
  }
}

describe('timeline', () => {
  it('一级分支全部在根节点右侧', () => {
    const result = layout('timeline');
    const root = box(result, 'root');
    for (const id of ['a', 'b']) {
      expect(box(result, id).x).toBeGreaterThan(root.x + root.width);
    }
  });

  it('一级分支上下交替', () => {
    const result = layout('timeline');
    const rootCenter = center(box(result, 'root'));
    expect(center(box(result, 'a')).y).toBeGreaterThan(rootCenter.y);
    expect(center(box(result, 'b')).y).toBeLessThan(rootCenter.y);
  });

  it('根到分支的连线是 axis（横段叠成主轴、竖段当刻度）', () => {
    const result = layout('timeline');
    const spokes = result.edges.filter((edge) => edge.parentId === 'root');
    expect(spokes).toHaveLength(2);
    for (const edge of spokes) expect(edge.lineStyle).toBe('axis');
  });

  it('后代朝远离主轴的方向堆叠', () => {
    const result = layout('timeline');
    // a 在下方，它的子节点应该更靠下
    expect(center(box(result, 'a1')).y).toBeGreaterThan(center(box(result, 'a')).y);
    // b 在上方，它的子节点应该更靠上
    expect(center(box(result, 'b1')).y).toBeLessThan(center(box(result, 'b')).y);
  });

  it('没有节点重叠', () => {
    assertNoOverlap(layout('timeline'));
  });
});

describe('fishbone', () => {
  it('鱼头在右：一级分支都在根节点左侧', () => {
    const result = layout('fishbone');
    const root = box(result, 'root');
    for (const id of ['a', 'b']) {
      expect(box(result, id).x + box(result, id).width).toBeLessThan(root.x);
    }
  });

  it('有一条合成的主轴边，从鱼头左边缘拉到最远附着点', () => {
    const result = layout('fishbone');
    const spine = result.edges.find((edge) => edge.id.startsWith('spine:'));
    expect(spine).toBeDefined();
    expect(spine!.to.x).toBeLessThan(spine!.from.x);
    expect(spine!.from.y).toBe(spine!.to.y);
  });

  it('主骨上下交替且是斜线', () => {
    const result = layout('fishbone');
    const rootCenter = center(box(result, 'root'));
    expect(center(box(result, 'a')).y).toBeLessThan(rootCenter.y);
    expect(center(box(result, 'b')).y).toBeGreaterThan(rootCenter.y);
    const bones = result.edges.filter((edge) => edge.parentId === 'root' && !edge.id.startsWith('spine:'));
    for (const bone of bones) {
      expect(bone.lineStyle).toBe('straight');
      expect(bone.from.y).not.toBe(bone.to.y);
    }
  });

  it('支骨向外排，且不与主骨重叠', () => {
    const result = layout('fishbone');
    expect(box(result, 'a1').x).toBeLessThan(box(result, 'a').x);
    expect(center(box(result, 'a1')).y).toBeLessThan(center(box(result, 'a')).y);
    assertNoOverlap(result);
  });
});

describe('brace', () => {
  it('所有分支在右侧，连线用括号形状', () => {
    const result = layout('brace');
    const root = box(result, 'root');
    for (const id of ['a', 'b', 'a1', 'b1']) {
      expect(box(result, id).x).toBeGreaterThan(root.x + root.width);
    }
    for (const edge of result.edges) expect(edge.lineStyle).toBe('brace');
  });

  it('兄弟不重叠，包围盒容得下所有节点', () => {
    const result = layout('brace');
    assertNoOverlap(result);
    for (const b of result.boxes.values()) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(result.bounds.width);
      expect(b.y + b.height).toBeLessThanOrEqual(result.bounds.height);
    }
  });
});

describe('tree-table', () => {
  it('同深度节点落在同一列', () => {
    const result = layout('tree-table');
    const byDepth = new Map<number, Set<number>>();
    for (const b of result.boxes.values()) {
      if (b.id.startsWith('f')) continue; // 自由主题不参与表格
      const set = byDepth.get(b.depth) ?? new Set<number>();
      set.add(b.x);
      byDepth.set(b.depth, set);
    }
    for (const [depth, xs] of byDepth) {
      expect(xs.size, `深度 ${depth} 出现了 ${xs.size} 个不同的 x`).toBe(1);
    }
  });

  it('父节点垂直居中于首末子节点之间', () => {
    const result = layout('tree-table');
    const a = box(result, 'a');
    const first = center(box(result, 'a1'));
    const last = center(box(result, 'a2'));
    expect(center(a).y).toBeCloseTo((first.y + last.y) / 2, 5);
  });

  it('连线是折线', () => {
    const result = layout('tree-table');
    const treeEdges = result.edges.filter((edge) => !edge.parentId.startsWith('f'));
    expect(treeEdges.length).toBeGreaterThan(0);
    for (const edge of treeEdges) expect(edge.lineStyle).toBe('elbow');
  });

  it('没有节点重叠', () => {
    assertNoOverlap(layout('tree-table'));
  });
});
