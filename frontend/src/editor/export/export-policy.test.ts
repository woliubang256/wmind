import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createDocument, createSheet, createTopic } from '../model/create';
import { DEFAULT_EXPORT_OPTIONS, buildExportContext, resolveExportOptions, type ExportFormat } from './context';
import { planFamilies } from './font-embed';
import { paintedRuns } from './fonts';
import { exportBranches, svgEncoder } from './split';
import { buildExportSvg } from './svg';

function documentForPolicy() {
  const doc = createDocument({ title: '导出策略' });
  doc.sheets = [createSheet({ id: 'one' }), createSheet({ id: 'two' })];
  for (const sheet of doc.sheets) {
    sheet.rootTopic.style = { fontFamily: 'system' };
    sheet.rootTopic.children.attached = ['A', 'B'].map((title) => createTopic({ id: `${sheet.id}-${title}`, title, style: { fontFamily: 'system' } }));
  }
  return doc;
}

describe('导出默认值与分享品牌策略', () => {
  it('所有入口默认 JPEG', () => {
    expect(DEFAULT_EXPORT_OPTIONS.format).toBe('jpeg');
  });

  it('内部可继续关闭、清空或自定义落款，且不突变原选项', () => {
    for (const brandText of ['', 'CUSTOM']) {
      const options = { ...DEFAULT_EXPORT_OPTIONS, brand: false, brandText };
      expect(resolveExportOptions(options)).toBe(options);
    }
  });

  it.each(['svg', 'png', 'jpeg', 'pdf'] as ExportFormat[])('%s 分享强制站点品牌并纳入可见文字与字体计划', (format) => {
    const options = { ...DEFAULT_EXPORT_OPTIONS, format, brand: false, brandText: 'CUSTOM' };
    const resolved = resolveExportOptions(options, '  固定品牌  ');
    const ctx = buildExportContext(documentForPolicy(), 'one', resolved);
    expect(ctx.brand).toBe(true);
    expect(ctx.brandText).toBe('固定品牌');
    expect(buildExportSvg(ctx)).toContain('>固定品牌<');
    expect(buildExportSvg(ctx)).not.toContain('CUSTOM');
    expect(paintedRuns(ctx)).toContainEqual(expect.objectContaining({ text: '固定品牌', family: 'sans', weight: 400 }));
    const plan = planFamilies(ctx).find((need) => need.family === 'sans');
    expect(plan?.weights.has('400')).toBe(true);
    expect(plan?.codePoints.has('固'.codePointAt(0)!)).toBe(true);
    expect(options.brand).toBe(false);
    expect(options.brandText).toBe('CUSTOM');
  });

  it('配置晚到与清空品牌不会保留旧品牌或生成无落款的图', () => {
    const options = { ...DEFAULT_EXPORT_OPTIONS, brand: false, brandText: 'CUSTOM' };
    expect(resolveExportOptions(options, 'FIRST').brandText).toBe('FIRST');
    expect(resolveExportOptions(options, 'NEXT').brandText).toBe('NEXT');
    expect(resolveExportOptions(options, '').brandText).toBe('wmind');
  });

  it.each(['md', 'opml', 'xmind'] as ExportFormat[])('%s 不扩大既有非图形规则', (format) => {
    const options = { ...DEFAULT_EXPORT_OPTIONS, format, brand: false, brandText: 'CUSTOM' };
    expect(resolveExportOptions(options, 'LOCKED')).toBe(options);
  });

  it('多画布及每个拆分分支都沿用已解析的锁定品牌', async () => {
    const doc = documentForPolicy();
    const options = resolveExportOptions({ ...DEFAULT_EXPORT_OPTIONS, format: 'svg', scope: 'all', brand: false, brandText: '' }, 'LOCKED');
    const full = buildExportContext(doc, 'one', options);
    expect(full.sheets).toHaveLength(2);
    expect(buildExportSvg(full)).toContain('>LOCKED<');
    const result = await exportBranches(doc, 'one', options, 'svg', { encode: svgEncoder });
    const files = unzipSync(result.bytes);
    expect(Object.keys(files)).toHaveLength(2);
    for (const bytes of Object.values(files)) expect(strFromU8(bytes)).toContain('>LOCKED<');
  });
});
