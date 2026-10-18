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

describe('未实现的结构', () => {
  it('退回 mindmap，而不是画不出来', () => {
    const timeline = layout('timeline');
    const mindmap = layout('mindmap');
    for (const id of ['root', 'a', 'b']) {
      expect(timeline.boxes.get(id)).toEqual(mindmap.boxes.get(id));
    }
  });
});
