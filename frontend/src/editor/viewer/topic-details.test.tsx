import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { docWithTree } from '../test-utils';
import { layoutMindmap } from '../layout/mindmap';
import { topicContentGeometry } from '../layout/topic-content';
import { TopicsLayer } from './layers';

describe('主题插入内容几何', () => {
  it('主题链接显示目标标题，不向用户展示内部协议与 id', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!;
    sheet.rootTopic.href = 'xmind:#a';
    const layout = layoutMindmap({ sheet, theme: doc.theme });
    const details = layout.sizes.get(sheet.rootTopic.id)!.details!;
    expect(details.entry).toMatchObject({ kind: 'link', title: 'A' });
    expect(details.height).toBe(0);
  });
  it('新增内容推动节点布局，内容与原标题图片不重叠，导出共用渲染', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; const topic = sheet.rootTopic;
    const before = layoutMindmap({ sheet, theme: doc.theme }).sizes.get(topic.id)!;
    topic.labels = ['很长的标签'.repeat(20)]; topic.notes.plain = '备注内容';
    topic.image = { src: '/image.png', width: 120, height: 80 };
    topic.content = { todo: false, sticker: 'star', illustration: 'growth', task: { progress: 30, priority: 1, assignee: '负责人', start: '', due: '2026-10-30' } };
    const layout = layoutMindmap({ sheet, theme: doc.theme }); const size = layout.sizes.get(topic.id)!; const box = layout.boxes.get(topic.id)!;
    expect(size.height).toBeGreaterThan(before.height + 200);
    const geo = topicContentGeometry(box, layout.styles.get(topic.id)!, size.lines, size.image, size.markers, size.details);
    expect(geo.detailsY).toBeGreaterThanOrEqual(geo.imageY + 80);
    expect(size.details!.badges[0]!.lines.length).toBeGreaterThan(1);
    const svg = renderToStaticMarkup(<svg><TopicsLayer layout={layout} showBadges={false} /></svg>);
    expect(svg).toContain('data-topic-content-kind="todo"');
    expect(svg).toContain('data-topic-content-kind="illustration"');
    expect(svg).not.toContain('NaN');
  });
  it('待办在标题左边，备注链接合并为右侧入口，不增加主行高度', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; const topic = sheet.rootTopic;
    const before = layoutMindmap({ sheet, theme: doc.theme }).sizes.get(topic.id)!;
    topic.content = { todo: false }; topic.notes.plain = '备注'; topic.href = 'https://example.com';
    const layout = layoutMindmap({ sheet, theme: doc.theme }); const size = layout.sizes.get(topic.id)!;
    const geo = topicContentGeometry(layout.boxes.get(topic.id)!, layout.styles.get(topic.id)!, size.lines, size.image, size.markers, size.details);
    expect(size.height).toBe(before.height);
    expect(geo.todoRect!.x + geo.todoRect!.width).toBeLessThanOrEqual(geo.textRect.x);
    expect(geo.entryRect!.x).toBeGreaterThanOrEqual(geo.textRect.x + geo.textRect.width);
    expect(size.details!.entry!.kind).toBe('more');
    expect(size.details!.lines).toHaveLength(0);
    const svg = renderToStaticMarkup(<svg><TopicsLayer layout={layout} showBadges={false} /></svg>);
    expect(svg).toContain('href="https://example.com"');
    expect(svg).not.toContain('role="button"');
  });
  it('标签在形状下方按 badge 换行，完整占用参与兄弟布局和导出', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; sheet.structure = 'logic-right';
    const topic = sheet.rootTopic.children.attached[0]!; topic.style = { width: 120, autoWidth: false };
    topic.labels = ['需求整理', '体验设计', '交付验收'];
    const layout = layoutMindmap({ sheet, theme: doc.theme }); const size = layout.sizes.get(topic.id)!;
    const box = layout.boxes.get(topic.id)!;
    expect(box.height).toBe(size.bodyHeight);
    expect(box.outerHeight).toBe(size.height);
    expect(size.details!.badges).toHaveLength(3);
    expect(new Set(size.details!.badges.map((badge) => badge.y)).size).toBeGreaterThan(1);
    expect(size.details!.labelHeight).toBeGreaterThan(20);
    expect(layout.bounds.y + layout.bounds.height).toBeGreaterThanOrEqual(box.y + size.height);
    const svg = renderToStaticMarkup(<svg><TopicsLayer layout={layout} showBadges={false} /></svg>);
    expect(svg).toContain('data-topic-label-badge');
  });

  it('窄固定宽度仍为待办、标题和右侧入口保留正宽度', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; const topic = sheet.rootTopic;
    topic.style = { autoWidth: false, width: 64 }; topic.title = '窄主题';
    topic.content = { todo: false }; topic.notes.plain = '备注'; topic.href = 'https://example.com';
    const layout = layoutMindmap({ sheet, theme: doc.theme }); const size = layout.sizes.get(topic.id)!;
    const geo = topicContentGeometry(layout.boxes.get(topic.id)!, layout.styles.get(topic.id)!, size.lines, size.image, size.markers, size.details);
    expect(geo.textRect.width).toBeGreaterThanOrEqual(16);
    expect(geo.todoRect!.x + 16).toBeLessThanOrEqual(geo.textRect.x);
    expect(geo.entryRect!.x).toBeGreaterThanOrEqual(geo.textRect.x + geo.textRect.width);
  });
  it.each(['mindmap', 'logic-right', 'org-chart'] as const)('%s 的兄弟主题为多行标签留足空间，连线仍使用形状中心', (structure) => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; sheet.structure = structure;
    const topic = sheet.rootTopic.children.attached[0]!;
    topic.children.attached = []; topic.style = { autoWidth: false, width: 110 };
    topic.labels = ['第一个标签', '第二个标签', '第三个标签'];
    const layout = layoutMindmap({ sheet, theme: doc.theme }); const a = layout.boxes.get('a')!; const b = layout.boxes.get('b')!;
    if (structure === 'logic-right') expect(b.y).toBeGreaterThanOrEqual(a.y + a.outerHeight!);
    if (structure === 'org-chart') expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
    const edge = layout.edges.find((item) => item.childId === 'a')!;
    expect(edge.to.y).toBeLessThanOrEqual(a.y + a.height);
  });

  it.each([1, 12])('主行入口与 %d 个 marker、图片和底部标签保持分离', (count) => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; const topic = sheet.rootTopic;
    topic.style = { autoWidth: false, width: 240, textAlign: 'left' }; topic.content = { todo: false }; topic.notes.plain = '备注';
    topic.markers = Array.from({ length: count }, (_, i) => ({ markerId: `priority-${i % 9 + 1}`, groupId: 'priority' }));
    topic.image = { src: '/image.png', width: 100, height: 60 }; topic.labels = ['标签'];
    const layout = layoutMindmap({ sheet, theme: doc.theme }); const size = layout.sizes.get(topic.id)!; const box = layout.boxes.get(topic.id)!;
    const geo = topicContentGeometry(box, layout.styles.get(topic.id)!, size.lines, size.image, size.markers, size.details);
    for (const marker of geo.markerRects) {
      expect(marker.x).toBeGreaterThan(geo.todoRect!.x + 16);
      expect(marker.x + marker.size).toBeLessThan(geo.entryRect!.x);
      expect(marker.y + marker.size).toBeLessThan(geo.imageY);
    }
    expect(geo.textRect.y + geo.textRect.height).toBeLessThan(geo.imageY);
    expect(geo.imageY + 60).toBeLessThan(box.y + box.height);
  });

});
