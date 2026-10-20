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
  SCALE_MAX,
  SCALE_MIN,
  SHEET_GAP,
  buildExportContext,
  clampScale,
  contentBounds,
  fitAspect,
  presetHasFill,
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

  it('边框只在开启时出现，颜色与粗细跟着预设走', () => {
    const doc = docWith();
    expect(buildExportSvg(buildExportContext(doc, 'sheet-0', opts({ border: 'thin' }))))
      .toContain('stroke="#D9D9D9"');
    expect(buildExportSvg(buildExportContext(doc, 'sheet-0', opts({ border: 'none' }))))
      .not.toContain('stroke="#D9D9D9"');
    // 红色预设：描边换色、加粗到 2px
    const red = buildExportSvg(buildExportContext(doc, 'sheet-0', opts({ border: 'red' })));
    expect(red).toContain('stroke="#E54D42"');
    expect(red).toContain('stroke-width="2"');
  });

  it('带底色的预设同时改背景，「透明背景」不再生效', () => {
    const doc = docWith();
    const ctx = buildExportContext(doc, 'sheet-0', opts({ border: 'green', transparent: true }));
    // 底色排在透明前面：选了「绿底」又勾透明，两者互相抵消，界面上没有说得通的结果。
    expect(ctx.background).toBe('#F1FAF4');
    expect(buildExportSvg(ctx)).toContain('fill="#F1FAF4"');
  });
});

describe('倍率与边框预设的纯规则', () => {
  it('自定义倍率夹在 0.5~8 之间，并保留一位小数', () => {
    expect(clampScale(2)).toBe(2);
    expect(clampScale(0.1)).toBe(SCALE_MIN);
    expect(clampScale(100)).toBe(SCALE_MAX);
    expect(clampScale(2.34)).toBe(2.3);
    expect(clampScale(2.36)).toBe(2.4);
  });

  it('非数值退回默认倍率，而不是 0', () => {
    // 空输入框会给出 NaN；退回 0 会让画布变成 0×0。
    expect(clampScale(Number.NaN)).toBe(DEFAULT_EXPORT_OPTIONS.scale);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EXPORT_OPTIONS.scale);
  });

  it('只有绿底 / 蓝底自带底色', () => {
    expect(presetHasFill('green')).toBe(true);
    expect(presetHasFill('blue')).toBe(true);
    for (const id of ['none', 'thin', 'red', 'orange'] as const) {
      expect(presetHasFill(id), id).toBe(false);
    }
  });
});

describe('长宽比', () => {
  it('auto 不动尺寸', () => {
    expect(fitAspect(400, 200, null)).toEqual({ width: 400, height: 200, extraX: 0, extraY: 0 });
  });

  it('太窄时只加宽，高度不变', () => {
    const fit = fitAspect(400, 400, 16 / 9);
    expect(fit.height).toBe(400);
    expect(fit.extraY).toBe(0);
    expect(fit.width).toBeGreaterThan(400);
    // 比例误差不超过 1px：多出来的空间取整后对称分配，不追求像素级精确。
    expect(Math.abs(fit.width / fit.height - 16 / 9)).toBeLessThan(0.01);
  });

  it('太扁时只加高，宽度不变', () => {
    const fit = fitAspect(800, 200, 1);
    expect(fit.width).toBe(800);
    expect(fit.extraX).toBe(0);
    expect(fit.height).toBe(800);
    expect(fit.extraY).toBe(300);
  });

  it('多出来的空间是整数且左右对称', () => {
    for (const ratio of [16 / 9, 4 / 3, 1, 9 / 16]) {
      const fit = fitAspect(333, 217, ratio);
      expect(Number.isInteger(fit.extraX), `extraX @ ${ratio}`).toBe(true);
      expect(Number.isInteger(fit.extraY), `extraY @ ${ratio}`).toBe(true);
      // 对称：base + 2 * extra，内容永远居中
      expect(fit.width === 333 || fit.width === 333 + fit.extraX * 2).toBe(true);
      expect(fit.height === 217 || fit.height === 217 + fit.extraY * 2).toBe(true);
    }
  });

  it('已经符合比例时不动', () => {
    expect(fitAspect(1600, 900, 16 / 9)).toEqual({ width: 1600, height: 900, extraX: 0, extraY: 0 });
  });

  it('非法比例退回不约束', () => {
    expect(fitAspect(400, 200, 0)).toEqual({ width: 400, height: 200, extraX: 0, extraY: 0 });
    expect(fitAspect(400, 200, Number.NaN)).toEqual({ width: 400, height: 200, extraX: 0, extraY: 0 });
  });

  it('上下文里内容随画布一起居中', () => {
    const doc = docWith();
    const auto = buildExportContext(doc, 'sheet-0', opts({ aspect: 'auto' }));
    const wide = buildExportContext(doc, 'sheet-0', opts({ aspect: '16:9' }));

    // 这张图很宽，16:9 需要加高
    expect(wide.width).toBe(auto.width);
    expect(wide.height).toBeGreaterThan(auto.height);

    const shifted = wide.sheets[0]!.offsetY - auto.sheets[0]!.offsetY;
    expect(shifted).toBeGreaterThan(0);

    // 居中的是**内容盒**（内容 + 留白 + 页脚），不是整个画布：
    // 品牌/日期贴着画布底边，所以下边距比上边距正好多一个页脚高度。
    const bottomGap = wide.height - (wide.sheets[0]!.offsetY + wide.sheets[0]!.bounds.height);
    expect(bottomGap - wide.sheets[0]!.offsetY).toBe(FOOTER_HEIGHT);
    // 加高量上下对称
    expect(wide.sheets[0]!.offsetY - auto.sheets[0]!.offsetY).toBe(
      Math.round((wide.height - auto.height) / 2),
    );
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
