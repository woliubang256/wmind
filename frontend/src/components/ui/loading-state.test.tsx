import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadingState } from './loading-state';
import '@/lib/i18n';

describe('统一加载状态', () => {
  it('整块加载只保留一份状态文字与隐藏的 W', () => {
    const html = renderToStaticMarkup(<LoadingState label="正在打开" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('<p>正在打开</p>');
    expect(html.match(/正在打开/g)).toHaveLength(1);
    expect(html).toContain('aria-hidden="true"');
  });
  it('行内与局部加载不使用整页尺寸，不增加额外说明', () => {
    const inline = renderToStaticMarkup(<LoadingState label="3 / 5" inline />);
    expect(inline).toMatch(/^<span role="status"/);
    expect(inline).toContain('wmind-loading-mark--inline');
    expect(inline).toContain('<span>3 / 5</span>');
    const small = renderToStaticMarkup(<LoadingState label="预览" small tone="soft" />);
    expect(small).toContain('wmind-loading-mark--small');
    expect(small).toContain('wmind-loading-mark--soft');
  });
});
