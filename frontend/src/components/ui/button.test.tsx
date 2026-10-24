import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './button';

describe('按钮加载', () => {
  it('加载时用小号 W 保留操作名称与禁用语义', () => {
    const html = renderToStaticMarkup(<Button loading>保存</Button>);
    expect(html).toContain('wmind-loading-mark--inline');
    expect(html).toContain('disabled="" aria-busy="true"');
    expect(html).toContain('保存</button>');
  });
  it('仅禁用不等于加载，普通按钮没有额外图标', () => {
    const html = renderToStaticMarkup(<Button disabled>保存</Button>);
    expect(html).not.toContain('wmind-loading-mark');
    expect(html).not.toContain('aria-busy');
  });
});
