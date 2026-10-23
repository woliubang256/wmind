import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { layoutAnnotations } from '../layout/annotations';
import { layoutMindmap } from '../layout/mindmap';
import { docWithTree } from '../test-utils';
import { RelationshipsLayer } from './decorations';

function render(interactive = false) {
  const doc = docWithTree();
  const sheet = doc.sheets[0]!;
  sheet.relationships.push({ id: 'r', end1Id: 'a1', end2Id: 'b1', title: '依赖', style: { lineStart: 'arrow', lineEnd: 'arrow', lineColor: '#123456', lineWidth: 4, borderStyle: 'dot' } });
  const annotations = layoutAnnotations(sheet, layoutMindmap({ sheet, theme: doc.theme }), doc.theme);
  return renderToStaticMarkup(<svg><RelationshipsLayer annotations={annotations} interactive={interactive} /></svg>);
}

describe('联系线渲染', () => {
  it('显式绘制两个箭头并保留线宽、颜色和虚线节奏', () => {
    const svg = render();
    expect(svg.match(/<polygon /g)).toHaveLength(2);
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('stroke-width="4"');
    expect(svg).toContain('stroke-dasharray="4 8"');
  });

  it('只有编辑态有宽命中区和键盘入口，导出只含实际图形', () => {
    expect(render(true)).toContain('data-relationship-hit');
    expect(render(true)).toContain('vector-effect="non-scaling-stroke"');
    expect(render(true)).toContain('tabindex="0"');
    expect(render()).not.toContain('data-relationship-hit');
    expect(render()).not.toContain('tabindex');
  });
});
