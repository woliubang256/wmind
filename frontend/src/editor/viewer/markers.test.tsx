import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MARKER_GROUPS } from '../import/markers';
import { docWithTree } from '../test-utils';
import { layoutMindmap } from '../layout/mindmap';
import { topicContentGeometry } from '../layout/topic-content';
import { TopicsLayer } from './layers';
import { MarkerIcon } from './marker-icon';

describe('Marker 渲染与内容几何', () => {
  it('红色主题上的红旗仍有独立衬底，画布与导出不会隐形', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!;
    sheet.rootTopic.style = { fill: '#E74646' };
    sheet.rootTopic.markers = [{ groupId: 'flag', markerId: 'flag-red' }];
    const svg = renderToStaticMarkup(<svg><TopicsLayer layout={layoutMindmap({ sheet, theme: doc.theme })} /></svg>);
    expect(svg).toContain('data-marker-background=""');
  });
  it('42 个图标均为独立 SVG 图形，未知标记可读回退', () => {
    const ids = Object.values(MARKER_GROUPS).flat();
    expect(ids).toHaveLength(42);
    for (const id of [...ids, 'unknown-marker']) {
      const svg = renderToStaticMarkup(<MarkerIcon markerId={id} />);
      expect(svg).toContain(`data-marker-id="${id}"`);
      expect(svg).toMatch(/<(path|circle|rect|polygon)/);
      expect(svg).not.toContain('NaN');
    }
  });
  it.each(['left', 'center', 'right'] as const)('图标与文字、图片无重叠，支持 %s 对齐', (textAlign) => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!;
    const topic = sheet.rootTopic;
    topic.markers = [{ groupId: 'priority', markerId: 'priority-1' }, { groupId: 'task', markerId: 'task-done' }];
    topic.title = '带标记的长标题'.repeat(10);
    topic.image = { src: '/image.png', width: 200, height: 60 };
    topic.style = { textAlign };
    const layout = layoutMindmap({ sheet, theme: doc.theme });
    const box = layout.boxes.get(topic.id)!; const size = layout.sizes.get(topic.id)!; const style = layout.styles.get(topic.id)!;
    const geo = topicContentGeometry(box, style, size.lines, size.image, size.markers);
    expect(geo.markerRects).toHaveLength(2);
    const last = geo.markerRects[1]!;
    expect(last.x + last.size).toBeLessThan(geo.textRect.x);
    expect(geo.textRect.y + geo.textRect.height).toBeLessThan(geo.imageY);
    const svg = renderToStaticMarkup(<svg><TopicsLayer layout={layout} showBadges={false} /></svg>);
    expect(svg).toContain('data-marker-id="priority-1"');
    expect(svg).not.toContain('role="button"');
  });
  it('固定窄宽下标记自动换行，仍在主题内并位于文字上方', () => {
    const doc = docWithTree(); const sheet = doc.sheets[0]!; const topic = sheet.rootTopic;
    topic.style = { width: 80, autoWidth: false };
    topic.markers = Object.entries(MARKER_GROUPS).map(([groupId, ids]) => ({ groupId, markerId: ids[0]! }));
    const layout = layoutMindmap({ sheet, theme: doc.theme });
    const box = layout.boxes.get(topic.id)!; const size = layout.sizes.get(topic.id)!;
    expect(size.markers!.inline).toBe(false);
    const geo = topicContentGeometry(box, layout.styles.get(topic.id)!, size.lines, size.image, size.markers);
    for (const rect of geo.markerRects) {
      expect(rect.x).toBeGreaterThanOrEqual(box.x);
      expect(rect.x + rect.size).toBeLessThanOrEqual(box.x + box.width);
      expect(rect.y + rect.size).toBeLessThan(geo.textRect.y);
    }
  });
});
