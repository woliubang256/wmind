import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadingImage, LoadingSvgImage } from './loading-image';

describe('图片浅灰加载', () => {
  it('保留原生懒加载、尺寸、替代文字与浅灰占位，不额外预请求', () => {
    const html = renderToStaticMarkup(<LoadingImage src="/test.png" alt="导图" loading="lazy" width={320} height={200} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('loading="lazy" width="320" height="200"');
    expect(html).toContain('alt="导图"');
    expect(html).toContain('wmind-loading-mark--soft');
    expect(html.match(/<img /g)).toHaveLength(1);
  });
  it('缺少图片地址不显示永不完成的动画', () => {
    const html = renderToStaticMarkup(<LoadingImage alt="无图片" />);
    expect(html).not.toContain('wmind-loading-mark');
    expect(html).not.toContain('aria-busy');
  });
  it('导出默认只输出原始 SVG image，实时加载才有占位且不改变几何', () => {
    const props = { href: '/test.png', x: 10, y: 20, width: 100, height: 80, preserveAspectRatio: 'xMidYMid meet' };
    const exported = renderToStaticMarkup(<svg><LoadingSvgImage {...props} /></svg>);
    expect(exported).not.toMatch(/wmind-loading|opacity=|<g>/);
    expect(exported).toContain('x="10" y="20" width="100" height="80"');
    const live = renderToStaticMarkup(<svg><LoadingSvgImage {...props} loading /></svg>);
    expect(live).toContain('wmind-loading-mark--soft');
    expect(live).toContain('x="40"');
    expect(live).toContain('pointer-events="none"');
  });
});
