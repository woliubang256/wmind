import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { docWithTree } from '../test-utils';
import { layoutMindmap } from '../layout/mindmap';
import { topicContentGeometry } from '../layout/topic-content';
import { TopicsLayer } from './layers';

describe('主题插入内容几何', () => {
  it('新增内容推动节点布局，内容与原标题图片不重叠，导出共用渲染', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; const topic = sheet.rootTopic;
    const before = layoutMindmap({ sheet, theme: doc.theme }).sizes.get(topic.id)!;
    topic.labels = ['很长的标签'.repeat(20)]; topic.notes.plain = '备注内容';
    topic.image = { src: '/image.png', width: 120, height: 80 };
    topic.content = { todo: false, sticker: 'star', illustration: 'growth', task: { progress: 30, priority: 1, assignee: '负责人', start: '', due: '2026-10-30' } };
    const layout = layoutMindmap({ sheet, theme: doc.theme }); const size = layout.sizes.get(topic.id)!; const box = layout.boxes.get(topic.id)!;
    expect(size.height).toBeGreaterThan(before.height + 200);
    const geo = topicContentGeometry(box, layout.styles.get(topic.id)!, size.lines, size.image, size.markers, size.details?.height);
    expect(geo.detailsY).toBeGreaterThanOrEqual(geo.imageY + 80);
    expect(size.details!.lines.filter((item) => item.kind === 'label').length).toBeGreaterThan(1);
    const svg = renderToStaticMarkup(<TopicsLayer layout={layout} showBadges={false} />);
    expect(svg).toContain('data-topic-content-kind="todo"');
    expect(svg).toContain('data-topic-content-kind="illustration"');
    expect(svg).not.toContain('NaN');
  });
});
