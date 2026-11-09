import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadingMark } from './loading-mark';

describe('加载 W 标志', () => {
  it('使用原 Logo 的四段 SVG 折带，不依赖图片、文字或网络', () => {
    const svg = renderToStaticMarkup(<LoadingMark />);
    expect(svg).toContain('viewBox="180 314 888 606"');
    expect(svg).toContain('width="72" height="50"');
    expect(svg.match(/<path /g)).toHaveLength(8);
    expect(svg).not.toMatch(/<(image|img|text)\b|https?:/);
  });

  it('标志对辅助技术隐藏，扫光被裁剪在 W 轮廓内', () => {
    const svg = renderToStaticMarkup(<LoadingMark />);
    expect(svg).toContain('aria-hidden="true" focusable="false"');
    expect(svg).toMatch(/<g clip-path="url\(#[^"]+\)"><g class="wmind-loading-mark__shine">/);
    expect(svg).toContain('stop-opacity="0.85"');
  });

  it('同页多个标志的渐变与裁剪 ID 互不冲突', () => {
    const svg = renderToStaticMarkup(<><LoadingMark /><LoadingMark /></>);
    const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, target] of svg.matchAll(/url\(#([^\)]+)\)/g)) expect(ids).toContain(target);
  });

  it('支持局部、按钮和浅灰图片尺寸，仍保留原有轮廓与可访问隐藏', () => {
    for (const size of ['small', 'inline'] as const) {
      const svg = renderToStaticMarkup(<LoadingMark size={size} tone="soft" className="custom" style={{ width: 24 }} />);
      expect(svg).toContain(`wmind-loading-mark--${size}`);
      expect(svg).toContain('wmind-loading-mark--soft custom');
      expect(svg).toContain('style="width:24px"');
      expect(svg).toContain('aria-hidden="true"');
    }
  });
});
