/**
 * 导出上下文与 SVG 序列化的测试。
 *
 * 这一组测试全部是纯函数断言——`renderToStaticMarkup` 在 node 环境下能跑，
 * 所以「导出的 SVG 里到底有什么」不需要浏览器就能验。真正需要浏览器的只有
 * 栅格化（M4.7）与下载动作。
 */

import { describe, expect, it } from 'vitest';
import { createDocument, createSheet, createTopic } from '../model/create';
import type { WmindDocument } from '../model/types';
import {
  DEFAULT_EXPORT_OPTIONS,
  FOOTER_HEIGHT,
  SHEET_GAP,
  buildExportContext,
  contentBounds,
} from './context';
import { buildExportSvg, exportFileName, svgDataUrl } from './svg';

function docWith(options: { sheets?: number; children?: number; title?: string } = {}): WmindDocument {
  const childCount = options.children ?? 2;
  const doc = createDocument({ title: options.title ?? '导出测试' });
  doc.sheets = Array.from({ length: options.sheets ?? 1 }, (_, index) => {
    const sheet = createSheet({ id: `sheet-${index}`, title: `画布 ${index}` });
    sheet.rootTopic = createTopic({ id: `root-${index}`, title: `根 ${index}` });
    for (let i = 0; i < childCount; i += 1) {
      sheet.rootTopic.children.attached.push(createTopic({ id: `c-${index}-${i}`, title: `分支 ${i}` }));
    }
    return sheet;
  });
  return doc;
}

const opts = (patch: Partial<typeof DEFAULT_EXPORT_OPTIONS> = {}) => ({
  ...DEFAULT_EXPORT_OPTIONS,
  ...patch,
});

describe('内容包围盒', () => {
  it('只按盒子算，不含布局自带的内边距', () => {
    const doc = docWith();
    const ctx = buildExportContext(doc, 'sheet-0', opts({ padding: 0, brand: false }));
    const sheet = ctx.sheets[0]!;
    const bounds = contentBounds(sheet.layout);

    // 留白为 0 时，画布尺寸就等于内容尺寸（不再多出布局的 80px 内边距）。
    expect(ctx.width).toBeCloseTo(bounds.width, 5);
    expect(ctx.height).toBeCloseTo(bounds.height, 5);
  });

  it('留白按倍数加在四周', () => {
    const doc = docWith();
    const zero = buildExportContext(doc, 'sheet-0', opts({ padding: 0, brand: false }));
    const padded = buildExportContext(doc, 'sheet-0', opts({ padding: 40, brand: false }));
    expect(padded.width - zero.width).toBe(80);
    expect(padded.height - zero.height).toBe(80);
  });
});

describe('导出上下文', () => {
  it('只导当前画布', () => {
    const doc = docWith({ sheets: 3 });
    const ctx = buildExportContext(doc, 'sheet-1', opts({ scope: 'current' }));
    expect(ctx.sheets.map((s) => s.id)).toEqual(['sheet-1']);
  });

  it('全部画布纵向排列，间距固定', () => {
    const doc = docWith({ sheets: 3 });
    const ctx = buildExportContext(doc, 'sheet-0', opts({ scope: 'all', padding: 20 }));
    expect(ctx.sheets).toHaveLength(3);
    const [first, second] = ctx.sheets;
    expect(second!.offsetY - (first!.offsetY + first!.bounds.height)).toBeCloseTo(SHEET_GAP, 5);
  });

  it('找不到当前画布时退回第一张，而不是报错', () => {
    const doc = docWith({ sheets: 2 });
    const ctx = buildExportContext(doc, '不存在', opts());
    expect(ctx.sheets).toHaveLength(1);
    expect(ctx.sheets[0]?.id).toBe('sheet-0');
  });

  it('透明时没有背景色，否则取主题背景', () => {
    const doc = docWith();
    expect(buildExportContext(doc, 'sheet-0', opts({ transparent: true })).background).toBeNull();
    expect(buildExportContext(doc, 'sheet-0', opts()).background)
      .toBe(doc.theme.palette.backgroundColor);
  });

  it('日期与品牌标识占一行底部空间', () => {
    const doc = docWith();
    const none = buildExportContext(doc, 'sheet-0', opts({ date: false, brand: false }));
    const both = buildExportContext(doc, 'sheet-0', opts({ date: true, brand: true }));
    expect(both.height - none.height).toBe(FOOTER_HEIGHT);
  });

  it('日期用本地时区，不会因为 UTC 跨日而差一天', () => {
    const doc = docWith();
    // 2026-10-20 23:30 +08:00 = 2026-10-20T15:30Z；`toISOString()` 会给出 20 号，
    // 但同一时刻在 UTC-5 是 20 号上午——这里只验证「取的是本地日期」这件事。
    const ctx = buildExportContext(doc, 'sheet-0', opts({ date: true }), new Date(2026, 9, 20, 23, 30));
    expect(ctx.date).toBe('2026-10-20');
  });

  it('空画布也能导出一张非零尺寸的图', () => {
    const doc = createDocument({ title: '空' });
    doc.sheets = [];
    const ctx = buildExportContext(doc, null, opts({ padding: 0 }));
    expect(ctx.width).toBeGreaterThan(0);
    expect(ctx.height).toBeGreaterThan(0);
  });
});

describe('SVG 序列化', () => {
  it('带 XML 声明与 svg 命名空间', () => {
    const svg = buildExportSvg(buildExportContext(docWith(), 'sheet-0', opts()));
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it('width / height 乘上倍率，viewBox 保持逻辑尺寸', () => {
    const ctx = buildExportContext(docWith(), 'sheet-0', opts({ scale: 2, padding: 20 }));
    const svg = buildExportSvg(ctx);
    expect(svg).toContain(`width="${Math.round(ctx.width * 2)}"`);
    expect(svg).toContain(`height="${Math.round(ctx.height * 2)}"`);
    expect(svg).toContain(`viewBox="0 0 ${ctx.width} ${ctx.height}"`);
  });

  it('节点标题写进 SVG，特殊字符被转义', () => {
    const doc = docWith({ title: '转义' });
    doc.sheets[0]!.rootTopic.title = 'A & B < C';
    const svg = buildExportSvg(buildExportContext(doc, 'sheet-0', opts()));
    expect(svg).toContain('A &amp; B &lt; C');
    expect(svg).not.toContain('A & B < C');
  });

  it('透明背景不画背景 rect', () => {
    const opaque = buildExportSvg(buildExportContext(docWith(), 'sheet-0', opts()));
    const transparent = buildExportSvg(
      buildExportContext(docWith(), 'sheet-0', opts({ transparent: true })),
    );
    expect(opaque).toContain('<rect x="0" y="0"');
    expect(transparent).not.toContain('<rect x="0" y="0"');
  });

  it('不画折叠徽标与折叠按钮（导出是成品，不是编辑器）', () => {
    const doc = docWith({ children: 3 });
    doc.sheets[0]!.rootTopic.collapsed = true;
    const svg = buildExportSvg(buildExportContext(doc, 'sheet-0', opts()));
    expect(svg).not.toContain('data-collapse-toggle');
  });

  it('品牌标识与日期按选项出现', () => {
    const doc = docWith();
    const withFooter = buildExportSvg(
      buildExportContext(doc, 'sheet-0', opts({ date: true, brand: true }), new Date(2026, 9, 20)),
    );
    expect(withFooter).toContain('2026-10-20');
    expect(withFooter).toContain('>wmind<');

    const none = buildExportSvg(buildExportContext(doc, 'sheet-0', opts({ date: false, brand: false })));
    expect(none).not.toContain('>wmind<');
  });

  it('多画布各自成组，带偏移', () => {
    const doc = docWith({ sheets: 2 });
    const ctx = buildExportContext(doc, 'sheet-0', opts({ scope: 'all' }));
    const svg = buildExportSvg(ctx);
    expect(svg).toContain('data-export-sheet="sheet-0"');
    expect(svg).toContain('data-export-sheet="sheet-1"');
    const offset = ctx.sheets[1]!.offsetY;
    expect(svg).toContain(`translate(${ctx.sheets[1]!.offsetX - ctx.sheets[1]!.bounds.x} ${offset - ctx.sheets[1]!.bounds.y})`);
  });

  it('边框只在开启时出现', () => {
    const doc = docWith();
    expect(buildExportSvg(buildExportContext(doc, 'sheet-0', opts({ border: true }))))
      .toContain('stroke="#D9D9D9"');
    expect(buildExportSvg(buildExportContext(doc, 'sheet-0', opts({ border: false }))))
      .not.toContain('stroke="#D9D9D9"');
  });
});

describe('数据 URL 与文件名', () => {
  it('中文标题也能编码（btoa 直接吃中文会抛错）', () => {
    const url = svgDataUrl(buildExportSvg(buildExportContext(docWith(), 'sheet-0', opts())));
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(url.length).toBeGreaterThan(100);
  });

  it('文件名去掉路径分隔符与保留字符', () => {
    expect(exportFileName('产品/规划:一期?', 'svg')).toBe('产品 规划 一期.svg');
    expect(exportFileName('   ', 'svg')).toBe('未命名导图.svg');
    expect(exportFileName('a'.repeat(200), 'svg').length).toBeLessThanOrEqual(84);
  });
});
