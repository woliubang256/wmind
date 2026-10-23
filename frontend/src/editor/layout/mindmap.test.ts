import { describe, expect, it } from 'vitest';
import { layoutMindmap } from './mindmap';
import { docWithTree, topic } from '../test-utils';
import { createDocument, createSheet, defaultTheme } from '../model/create';
import type { NodeBox } from './types';
import type { Topic } from '../model/types';

/** 所有节点固定 100×40：几何完全可预测，断言不用看字体度量。 */
const stubMeasure = (topic: Topic) => ({ width: 100, height: 40, lines: [topic.title], image: null });

function layout(options: Parameters<typeof layoutMindmap>[0]['options'] = {}) {
  const doc = docWithTree();
  return layoutMindmap({
    sheet: doc.sheets[0]!,
    theme: defaultTheme(),
    measure: stubMeasure,
    options,
  });
}

function box(result: ReturnType<typeof layout>, id: string): NodeBox {
  const found = result.boxes.get(id);
  if (!found) throw new Error(`缺少节点 ${id}`);
  return found;
}

function overlaps(a: NodeBox, b: NodeBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe('mindmap 布局', () => {
  it('20 个主分支沿中心主题轮廓有序分散，而不是每侧共用一个中点', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0]!;
    sheet.rootTopic.id = 'root';
    sheet.rootTopic.children.attached = Array.from({ length: 20 }, (_, i) => topic(`main-${i}`, `分支 ${i}`));
    const result = layoutMindmap({ sheet, theme: doc.theme, measure: stubMeasure });
    const root = box(result, 'root');
    for (const side of ['left', 'right']) {
      const edges = result.edges.filter((edge) => box(result, edge.childId).side === side);
      expect(edges).toHaveLength(10);
      expect(new Set(edges.map((edge) => `${edge.from.x},${edge.from.y}`)).size).toBe(10);
      expect(edges[0]!.from.y).toBeLessThan(root.y + root.height / 2);
      expect(edges.at(-1)!.from.y).toBeGreaterThan(root.y + root.height / 2);
    }
  });

  it('子树高度不均时，曲线从端口向外展开，不折回中心主题内部', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0]!;
    sheet.topicShape = 'rect';
    sheet.rootTopic.children.attached = Array.from({ length: 10 }, (_, i) => topic(`main-${i}`, `分支 ${i}`));
    sheet.rootTopic.children.attached[0]!.children.attached = Array.from({ length: 12 }, (_, i) => topic(`sub-${i}`, `子主题 ${i}`));
    const result = layoutMindmap({ sheet, theme: doc.theme, measure: stubMeasure });
    const root = result.boxes.get(sheet.rootTopic.id)!;
    for (const edge of result.edges.filter((edge) => edge.parentId === root.id)) {
      const first = edge.curveControls![0];
      if (Math.abs(edge.from.y - root.y) < 1e-6) expect(first.y).toBeLessThanOrEqual(edge.from.y);
      if (Math.abs(edge.from.y - root.y - root.height) < 1e-6) expect(first.y).toBeGreaterThanOrEqual(edge.from.y);
      if (Math.abs(edge.from.x - root.x) < 1e-6) expect(first.x).toBeLessThanOrEqual(edge.from.x);
      if (Math.abs(edge.from.x - root.x - root.width) < 1e-6) expect(first.x).toBeGreaterThanOrEqual(edge.from.x);
    }
  });

  it('曲线子主题使用短横线接圆角分叉，主分支间距大于子主题间距', () => {
    const result = layout();
    expect(result.edges.find((edge) => edge.childId === 'a1')!.lineStyle).toBe('brace');
    const root = box(result, 'root');
    const a = box(result, 'a');
    const a1 = box(result, 'a1');
    expect(a.x - root.x - root.width).toBeGreaterThan(a1.x - a.x - a.width);
  });

  it.each(['rect', 'rounded-rect', 'capsule', 'ellipse', 'circle', 'diamond', 'hexagon', 'parallelogram', 'underline', 'none'] as const)(
    '%s 在紧凑/单侧模式中保持有限几何，平移控制点后仍在端点范围内', (shape) => {
      const doc = createDocument();
      const sheet = doc.sheets[0]!;
      sheet.topicShape = shape;
      sheet.rootTopic.children.attached = Array.from({ length: 7 }, (_, i) => topic(`main-${i}`, `分支 ${i}`, [topic(`child-${i}`, '子主题')]));
      for (const compact of [true, false]) {
        const result = layoutMindmap({ sheet, theme: doc.theme, measure: stubMeasure, options: { compact, autoBalance: false } });
        for (const edge of result.edges) {
          for (const point of [edge.from, edge.to, ...(edge.curveControls ?? [])]) {
            expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeGreaterThanOrEqual(0);
          }
          for (const point of edge.curveControls ?? []) {
            expect(point.x).toBeGreaterThanOrEqual(Math.min(edge.from.x, edge.to.x));
            expect(point.x).toBeLessThanOrEqual(Math.max(edge.from.x, edge.to.x));
            expect(point.y).toBeGreaterThanOrEqual(Math.min(edge.from.y, edge.to.y));
            expect(point.y).toBeLessThanOrEqual(Math.max(edge.from.y, edge.to.y));
          }
        }
      }
    });

  it('分散端点保留子主题显式线型、颜色、宽度和箭头', () => {
    const doc = docWithTree();
    const sheet = doc.sheets[0]!;
    sheet.rootTopic.children.attached[0]!.style = { lineStyle: 'straight', lineColor: '#123456', lineWidth: 4, lineEnd: 'arrow' };
    sheet.rootTopic.children.attached[0]!.children.attached[0]!.style = { lineStyle: 'elbow' };
    sheet.rootTopic.children.attached[1]!.style = { lineStyle: 'none' };
    const result = layoutMindmap({ sheet, theme: doc.theme, measure: stubMeasure });
    expect(result.edges.find((edge) => edge.childId === 'a')).toMatchObject({ lineStyle: 'straight', lineColor: '#123456', lineWidth: 4, lineEnd: 'arrow' });
    expect(result.edges.find((edge) => edge.childId === 'a1')!.lineStyle).toBe('elbow');
    expect(result.edges.find((edge) => edge.childId === 'b')!.lineStyle).toBe('none');
  });

  it('所有可见节点都有盒子，根节点 side 为 none', () => {
    const result = layout();
    expect([...result.boxes.keys()].sort()).toEqual(['a', 'a1', 'a2', 'b', 'b1', 'f1', 'f1x', 'root']);
    expect(box(result, 'root').side).toBe('none');
    // 一级分支按下标奇偶交替：0 → 右，1 → 左。
    expect(box(result, 'a').side).toBe('right');
    expect(box(result, 'b').side).toBe('left');
  });

  it('自由主题排在整棵树的下方，且不参与左右平衡', () => {
    const result = layout();
    const treeBottom = Math.max(
      ...[...result.boxes.values()]
        .filter((b) => !b.id.startsWith('f'))
        .map((b) => b.y + b.height),
    );
    expect(box(result, 'f1').y).toBeGreaterThan(treeBottom);
    expect(box(result, 'f1').side).toBe('right');
    // 自由主题的子节点挂在它右侧，与树的层级无关。
    expect(box(result, 'f1x').x).toBeGreaterThan(box(result, 'f1').x);
  });

  it('折叠节点的后代不参与布局，且记录隐藏数量', () => {
    const result = layout();
    expect(result.boxes.has('a2x')).toBe(false);
    expect(box(result, 'a2').collapsed).toBe(true);
    expect(box(result, 'a2').hiddenChildren).toBe(1);
  });

  it('任意两个节点不重叠', () => {
    const result = layout();
    const boxes = [...result.boxes.values()];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlaps(boxes[i]!, boxes[j]!), `${boxes[i]!.id} 与 ${boxes[j]!.id} 重叠`).toBe(false);
      }
    }
  });

  it('包围盒包含所有节点并留出内边距', () => {
    const result = layout();
    const { bounds } = result;
    for (const b of result.boxes.values()) {
      expect(b.x).toBeGreaterThanOrEqual(bounds.x);
      expect(b.y).toBeGreaterThanOrEqual(bounds.y);
      expect(b.x + b.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(b.y + b.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    // 内容左上角就是 padding（80）
    const minX = Math.min(...[...result.boxes.values()].map((b) => b.x));
    const minY = Math.min(...[...result.boxes.values()].map((b) => b.y));
    expect(minX).toBe(80);
    expect(minY).toBe(80);
  });

  it('父子连线的端点落在节点边缘上', () => {
    const result = layout();
    // 树 6 个节点 → 5 条边，加自由主题的 1 条 = 6 条
    expect(result.edges).toHaveLength(6);

    for (const edge of result.edges) {
      const parent = box(result, edge.parentId);
      const child = box(result, edge.childId);
      const midParent = parent.y + parent.height / 2;
      const midChild = child.y + child.height / 2;
      expect(edge.from.y).toBeCloseTo(midParent, 5);
      expect(edge.to.y).toBeCloseTo(midChild, 5);
      if (child.side === 'right') {
        expect(edge.from.x).toBeCloseTo(parent.x + parent.width, 5);
        expect(edge.to.x).toBeCloseTo(child.x, 5);
      } else {
        expect(edge.from.x).toBeCloseTo(parent.x, 5);
        expect(edge.to.x).toBeCloseTo(child.x + child.width, 5);
      }
    }
  });

  it('连线颜色取自子节点（分支色跟着分支走）', () => {
    const result = layout();
    const toA1 = result.edges.find((e) => e.childId === 'a1')!;
    const toB1 = result.edges.find((e) => e.childId === 'b1')!;
    expect(toA1.lineColor).not.toBe(toB1.lineColor);
  });

  it('关闭自动平衡后所有一级分支排在右侧', () => {
    const result = layout({ autoBalance: false });
    expect(box(result, 'a').side).toBe('right');
    expect(box(result, 'b').side).toBe('right');
    expect(box(result, 'root').x).toBeLessThan(box(result, 'a').x);
  });

  it('同一侧的子节点按文档顺序自上而下排列', () => {
    const result = layout({ autoBalance: false });
    expect(box(result, 'a').y).toBeLessThan(box(result, 'b').y);
    expect(box(result, 'a1').y).toBeLessThan(box(result, 'a2').y);
  });

  it('父节点在自己子节点组的垂直中间', () => {
    const result = layout({ autoBalance: false });
    const a = box(result, 'a');
    const a1 = box(result, 'a1');
    const a2 = box(result, 'a2');
    const center = (a1.y + a2.y + a2.height) / 2;
    expect(a.y + a.height / 2).toBeCloseTo(center, 5);
  });

  it('紧凑模式减少总高度', () => {
    const normal = layout();
    const compact = layout({ compact: true });
    expect(compact.bounds.height).toBeLessThan(normal.bounds.height);
    expect(compact.bounds.width).toBeLessThan(normal.bounds.width);
  });

  it('空画布（只有根）也能布局', () => {
    const doc = docWithTree();
    doc.sheets[0]!.rootTopic.children.attached = [];
    doc.sheets[0]!.floatingTopics = [];
    const result = layoutMindmap({
      sheet: doc.sheets[0]!,
      theme: defaultTheme(),
      measure: stubMeasure,
    });
    expect(result.boxes.size).toBe(1);
    expect(result.edges).toEqual([]);
    expect(result.bounds.width).toBe(100 + 160);
  });

  it('单节点画布返回带内边距的包围盒', () => {
    const result = layout();
    expect(result.bounds.width).toBeGreaterThan(0);
    expect(result.bounds.height).toBeGreaterThan(0);
  });
});

describe('性能基线', () => {
  it('1000 节点布局在 1.5s 内完成（验收标准 3 的布局部分）', () => {
    // 构造 1 根 + 10 个一级分支，每个分支 99 个二级节点 = 1001 个节点。
    const doc = docWithTree();
    const root = doc.sheets[0]!.rootTopic;
    root.children.attached = [];
    doc.sheets[0]!.floatingTopics = [];
    for (let b = 0; b < 10; b += 1) {
      const branch = topic(`br-${b}`, `分支 ${b}`);
      for (let i = 0; i < 99; i += 1) {
        branch.children.attached.push(topic(`n-${b}-${i}`, `节点 ${b}-${i}`));
      }
      root.children.attached.push(branch);
    }

    const started = performance.now();
    const result = layoutMindmap({
      sheet: doc.sheets[0]!,
      theme: defaultTheme(),
      measure: stubMeasure,
    });
    const elapsed = performance.now() - started;

    expect(result.boxes.size).toBe(1001);
    expect(elapsed).toBeLessThan(1500);
    // 顺带确认没有退化成 O(n²)：1000 节点的布局在开发机上通常是几毫秒。
    expect(elapsed).toBeLessThan(500);
  });
});

describe('布局开关', () => {
  /** 宽度随标题长度变化，才能看出「列对齐」到底对齐了什么。 */
  const variableMeasure = (t: Topic) => ({
    width: 60 + t.title.length * 24,
    height: 40,
    lines: [t.title],
    image: null,
  });

  /** 单向树：两个一级分支都在右侧，且宽度不同。 */
  function rightTree(
    options: Parameters<typeof layoutMindmap>[0]['options'] = {},
    measure = variableMeasure,
  ) {
    const doc = createDocument({ title: 't' });
    doc.sheets = [
      {
        ...createSheet({ id: 'sh', structure: 'logic-right' }),
        rootTopic: topic('root', '中心主题', [
          topic('a', '很长的分支标题', [topic('a1', 'A1')]),
          topic('b', 'B', [topic('b1', 'B1')]),
        ]),
        floatingTopics: [],
      },
    ];
    return layoutMindmap({ sheet: doc.sheets[0]!, theme: defaultTheme(), measure, options });
  }

  it('紧凑型把同级与父子间距都压小', () => {
    const normal = layout({ compact: false });
    const compact = layout({ compact: true });
    expect(compact.bounds.width).toBeLessThan(normal.bounds.width);
    expect(compact.bounds.height).toBeLessThan(normal.bounds.height);
  });

  it('关闭自动平衡后一级分支全在右侧', () => {
    const result = layout({ autoBalance: false });
    expect(box(result, 'a').side).toBe('right');
    expect(box(result, 'b').side).toBe('right');
    expect(box(result, 'b').x).toBeGreaterThan(box(result, 'root').x);
  });

  it('同级对齐让同深度节点落在同一列', () => {
    const loose = rightTree();
    expect(box(loose, 'a1').x).not.toBe(box(loose, 'b1').x);

    const aligned = rightTree({ alignSiblings: true });
    expect(box(aligned, 'a').x).toBe(box(aligned, 'b').x);
    expect(box(aligned, 'a1').x).toBe(box(aligned, 'b1').x);
    // 对齐的是列，不是 y：同层节点仍然各自占自己的垂直位置。
    expect(box(aligned, 'a1').y).not.toBe(box(aligned, 'b1').y);
  });

  it('同级对齐不影响自由主题的位置', () => {
    const plain = layout({ alignSiblings: false });
    const aligned = layout({ alignSiblings: true });
    const offset = (result: ReturnType<typeof layout>) => box(result, 'f1').x - box(result, 'root').x;
    expect(offset(aligned)).toBe(offset(plain));
  });

  it('纵向树忽略列对齐（它对齐的是行）', () => {
    const doc = docWithTree();
    doc.sheets[0]!.structure = 'org-chart';
    const plain = layoutMindmap({ sheet: doc.sheets[0]!, theme: defaultTheme(), measure: stubMeasure });
    const aligned = layoutMindmap({
      sheet: doc.sheets[0]!,
      theme: defaultTheme(),
      measure: stubMeasure,
      options: { alignSiblings: true },
    });
    expect([...aligned.boxes.entries()].map(([id, b]) => [id, b.x, b.y])).toEqual(
      [...plain.boxes.entries()].map(([id, b]) => [id, b.x, b.y]),
    );
  });
});
