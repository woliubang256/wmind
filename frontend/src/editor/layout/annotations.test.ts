import { describe, expect, it } from 'vitest';
import { layoutMindmap } from './mindmap';
import { ANNOTATION_METRICS, bracePath, layoutAnnotations, relationshipArc, unionRect } from './annotations';
import { createDocument } from '../model/create';
import { docWithTree } from '../test-utils';
import type { Boundary, Sheet, Summary } from '../model/types';

function sheetWith(extra: Partial<Sheet>): { sheet: Sheet; theme: ReturnType<typeof createDocument>['theme'] } {
  const doc = createDocument({ title: '测试导图' });
  const base = docWithTree();
  const sheet: Sheet = { ...base.sheets[0]!, ...extra };
  return { sheet, theme: doc.theme };
}

const summary = (over: Partial<Summary> = {}): Summary => ({
  id: 's1',
  topicId: 'a',
  range: ['a1', 'a2'],
  title: '概要',
  style: null,
  ...over,
});

const boundary = (over: Partial<Boundary> = {}): Boundary => ({
  id: 'b1',
  title: '分组',
  range: ['a', 'b'],
  style: null,
  ...over,
});

describe('unionRect', () => {
  it('外扩留白，宽高都算上', () => {
    expect(unionRect([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 30, width: 10, height: 10 }], 5)).toEqual({
      x: -5,
      y: -5,
      // 并集本身是 30×40，四边各外扩 5。
      width: 40,
      height: 50,
    });
  });

  it('空数组返回 null（调用方据此跳过这一条）', () => {
    expect(unionRect([])).toBeNull();
  });
});

describe('bracePath', () => {
  it('开口朝左：两端贴住范围右缘，竖线在右侧 gap/2 处', () => {
    const d = bracePath({ x: 100, y: 50, width: 80, height: 60 });
    const x = 180;
    const bx = x + ANNOTATION_METRICS.summaryGap / 2;
    expect(d.startsWith(`M ${x} 50`)).toBe(true);
    expect(d).toContain(`Q ${bx} 50`);
    expect(d).toContain(`L ${bx} ${110 - 12}`);
  });

  it('范围很矮时圆角半径收到一半高度，两端不会叠成一团', () => {
    const d = bracePath({ x: 0, y: 0, width: 40, height: 8 });
    const bx = 40 + ANNOTATION_METRICS.summaryGap / 2;
    // radius = min(12, 8/2) = 4
    expect(d).toContain(`Q ${bx} 0 ${bx} 4`);
    expect(d).toContain(`Q ${bx} 8`);
  });
});

describe('relationshipArc', () => {
  it('控制点偏离弦，弧才不会被中间节点盖住', () => {
    const arc = relationshipArc(
      { x: 0, y: 0, width: 40, height: 20 },
      { x: 200, y: 0, width: 40, height: 20 },
    );
    expect(arc.from).toEqual({ x: 20, y: 10 });
    expect(arc.to).toEqual({ x: 220, y: 10 });
    // 两点水平相邻：法线是竖直方向，控制点必须离开 y = 10。
    expect(arc.control.y).not.toBeCloseTo(10);
    expect(arc.label.x).toBeGreaterThan(20);
    expect(arc.label.x).toBeLessThan(220);
  });

  it('外推幅度封顶 60px', () => {
    const arc = relationshipArc(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 2000, y: 0, width: 10, height: 10 },
    );
    expect(Math.abs(arc.control.y - 5)).toBeLessThanOrEqual(60.001);
  });
});

describe('layoutAnnotations', () => {
  it.each(['straight', 'curve', 'elbow'] as const)('联系 %s 线支持样式、双端箭头且端点在主题边缘', (lineStyle) => {
    const { sheet, theme } = sheetWith({ relationships: [{
      id: 'r', end1Id: 'a1', end2Id: 'b1', title: '依赖',
      style: { lineColor: '#E32925', lineWidth: 4, borderStyle: 'solid', lineStyle, lineStart: 'arrow', lineEnd: 'arrow' },
    }] });
    const layout = layoutMindmap({ sheet, theme });
    const item = layoutAnnotations(sheet, layout, theme).relationships[0]!;
    expect(item).toMatchObject({ color: '#E32925', width: 4, dash: undefined, lineStart: 'arrow', lineEnd: 'arrow' });
    expect(item.path).toContain(lineStyle === 'curve' ? ' Q ' : ' L ');
    for (const [point, box] of [[item.from, layout.boxes.get('a1')!], [item.to, layout.boxes.get('b1')!]] as const) {
      const edgeDistance = Math.min(Math.abs(point.x - box.x), Math.abs(point.x - box.x - box.width), Math.abs(point.y - box.y), Math.abs(point.y - box.y - box.height));
      expect(edgeDistance).toBeLessThan(0.001);
    }
  });

  it('很长的联系标题与弧线都计入包围盒，导出不会截断', () => {
    const { sheet, theme } = sheetWith({ relationships: [{ id: 'r', end1Id: 'a1', end2Id: 'b1', title: '很长的联系说明'.repeat(20), style: null }] });
    const layout = layoutMindmap({ sheet, theme });
    const annotations = layoutAnnotations(sheet, layout, theme);
    expect(annotations.bounds).not.toBeNull();
    expect(annotations.bounds!.width).toBeGreaterThan(layout.bounds.width);
  });
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  it('左侧概要向左展开，不压在父主题下', () => {
    const { sheet, theme } = sheetWith({ summaries: [summary()], structure: 'logic-left' });
    const layout = layoutMindmap({ sheet, theme });
    const item = layoutAnnotations(sheet, layout, theme).summaries[0]!;
    const left = Math.min(layout.boxes.get('a1')!.x, layout.boxes.get('a2')!.x);
    expect(item.rect.x + item.rect.width).toBeLessThan(left);
    expect([...layout.boxes.values()].some((box) => overlaps(item.rect, box))).toBe(false);
    expect(item.connector.to.x).toBe(item.rect.x + item.rect.width);
  });

  it('自动避让主题以及同范围的历史概要，包围盒包含避让后节点', () => {
    const { sheet, theme } = sheetWith({ summaries: [summary(), summary({ id: 's2' })] });
    const layout = layoutMindmap({ sheet, theme });
    const initial = layoutAnnotations(sheet, layout, theme).summaries[0]!;
    layout.boxes.set('obstacle', { ...layout.boxes.get('a1')!, ...initial.rect, id: 'obstacle' });
    const annotations = layoutAnnotations(sheet, layout, theme);
    const [first, second] = annotations.summaries;
    for (const item of annotations.summaries) {
      expect([...layout.boxes.values()].some((box) => overlaps(item.rect, box))).toBe(false);
      expect(item.rect.x + item.rect.width).toBeLessThanOrEqual(annotations.bounds!.x + annotations.bounds!.width);
    }
    expect(overlaps(first!.rect, second!.rect)).toBe(false);
  });

  it('概要贴在范围的右侧、竖直居中', () => {
    const { sheet, theme } = sheetWith({ summaries: [summary()] });
    const layout = layoutMindmap({ sheet, theme });
    const annotations = layoutAnnotations(sheet, layout, theme);

    const item = annotations.summaries[0]!;
    const a1 = layout.boxes.get('a1')!;
    const a2 = layout.boxes.get('a2')!;
    const right = Math.max(a1.x + a1.width, a2.x + a2.width);
    expect(item.rect.x).toBeCloseTo(right + ANNOTATION_METRICS.summaryGap, 5);
    // 竖直中心落在两个节点的并集中心附近。
    const center = (Math.min(a1.y, a2.y) + Math.max(a1.y + a1.height, a2.y + a2.height)) / 2;
    expect(item.rect.y + item.rect.height / 2).toBeCloseTo(center, 5);
  });

  it('范围里的 id 都不在画布上时跳过这一条', () => {
    const { sheet, theme } = sheetWith({ summaries: [summary({ range: ['ghost'] })] });
    const layout = layoutMindmap({ sheet, theme });
    expect(layoutAnnotations(sheet, layout, theme).summaries).toHaveLength(0);
  });

  it('边界按留白外扩，样式取自主题的 boundary', () => {
    const { sheet, theme } = sheetWith({ boundaries: [boundary()] });
    const layout = layoutMindmap({ sheet, theme });
    const annotations = layoutAnnotations(sheet, layout, theme);
    const item = annotations.boundaries[0]!;
    const a = layout.boxes.get('a')!;
    const b = layout.boxes.get('b')!;
    expect(item.rect.x).toBeCloseTo(Math.min(a.x, b.x) - ANNOTATION_METRICS.boundaryPadding, 5);
    expect(item.strokeWidth).toBeGreaterThan(0);
    // 默认是虚线：`stroke-dasharray` 有值，纯实线才允许 undefined。
    expect(item.strokeDasharray).toBeDefined();
  });

  it('主题级（XMind 导入）的边界也会被收进来', () => {
    const { sheet, theme } = sheetWith({});
    const withTopicBoundary: Sheet = {
      ...sheet,
      rootTopic: {
        ...sheet.rootTopic,
        boundaries: [boundary({ range: ['a'] })],
      },
    };
    const layout = layoutMindmap({ sheet: withTopicBoundary, theme });
    expect(layoutAnnotations(withTopicBoundary, layout, theme).boundaries).toHaveLength(1);
  });

  it('关系线两端都存在的才画', () => {
    const { sheet, theme } = sheetWith({
      relationships: [
        { id: 'r1', end1Id: 'a1', end2Id: 'b1', title: '', style: null },
        { id: 'r2', end1Id: 'a1', end2Id: 'ghost', title: '', style: null },
      ],
    });
    const layout = layoutMindmap({ sheet, theme });
    expect(layoutAnnotations(sheet, layout, theme).relationships.map((item) => item.id)).toEqual(['r1']);
  });

  it('包围盒把概要节点算进去——「缩放到适应」才不会把它切掉', () => {
    const { sheet, theme } = sheetWith({ summaries: [summary()] });
    const layout = layoutMindmap({ sheet, theme });
    const withSummary = layoutAnnotations(sheet, layout, theme);
    const withoutSummary = layoutAnnotations({ ...sheet, summaries: [] }, layout, theme);

    expect(withoutSummary.bounds).toBeNull();
    const item = withSummary.summaries[0]!;
    // 只有概要这一条附属结构时，包围盒就是它自己的矩形。
    expect(withSummary.bounds!.x + withSummary.bounds!.width).toBeCloseTo(item.rect.x + item.rect.width, 5);
    // 而且它确实比最右侧的节点还要靠右——否则这个包围盒没有意义。
    const rightmostBox = Math.max(...[...layout.boxes.values()].map((box) => box.x + box.width));
    expect(item.rect.x + item.rect.width).toBeGreaterThan(rightmostBox);
  });
});
