/**
 * 导出前字体回退检测的测试。
 *
 * 重点不是「能找出缺字」，而是**只报真正会画出来的字**：备注不画、`system` 族
 * 不算回退、空白不算缺字。误报会让提示变成噪音，用户很快就学会无视它。
 */

import { describe, expect, it } from 'vitest';
import { createDocument, createSheet, createTopic } from '../model/create';
import type { Sheet, Topic, WmindDocument } from '../model/types';
import { DEFAULT_EXPORT_OPTIONS, buildExportContext } from './context';
import { detectFallback } from './fonts';
import { planFamilies } from './font-embed';
import { buildExportSvg } from './svg';

function sheetWith(titles: string[]): Sheet {
  const sheet = createSheet({ id: 'sheet-0', title: '画布 0' });
  sheet.rootTopic = createTopic({ id: 'root', title: '根' });
  titles.forEach((title, index) => {
    sheet.rootTopic.children.attached.push(createTopic({ id: `t-${index}`, title }));
  });
  return sheet;
}

function ctxOf(sheet: Sheet, document?: Partial<WmindDocument>) {
  const doc = createDocument({ title: '测试' });
  doc.sheets = [sheet];
  Object.assign(doc, document);
  return buildExportContext(doc, 'sheet-0', { ...DEFAULT_EXPORT_OPTIONS, brand: false });
}

function topicAt(sheet: Sheet, index: number): Topic {
  return sheet.rootTopic.children.attached[index]!;
}

describe('detectFallback', () => {
  it('标签、任务负责人和附件名称的可见文字也检查', () => {
    const sheet = sheetWith(['正常']);
    topicAt(sheet, 0).labels = ['😀'];
    topicAt(sheet, 0).content = {
      task: { progress: 0, priority: 0, assignee: '𠮷', start: '', due: '' },
      attachments: [{ id: 'file-0', name: '🤖.txt', data: '', bytes: 0, kind: 'file' }],
    };
    const ctx = ctxOf(sheet);
    const markup = buildExportSvg(ctx).replace(/<title>.*?<\/title>/gs, '');
    expect(markup).toMatch(/<tspan\b[^>]*>😀<\/tspan>/);
    expect(markup).toContain('𠮷');
    expect(markup).toContain('🤖.txt');
    const report = detectFallback(ctx);
    expect(report.chars).toContain('😀');
    expect(report.chars).toContain('𠮷');
    expect(report.chars).toContain('🤖');
  });

  it('空标题的 system 主题仍按 sans 400 检测与内嵌标签', () => {
    const sheet = sheetWith(['']);
    sheet.rootTopic.style = { fontFamily: 'system' };
    topicAt(sheet, 0).style = { fontFamily: 'system', fontWeight: 800, fontStyle: 'italic' };
    topicAt(sheet, 0).labels = ['😀标签'];
    const ctx = ctxOf(sheet);
    expect(buildExportSvg(ctx)).toMatch(/<tspan\b[^>]*>😀标签<\/tspan>/);
    expect(detectFallback(ctx).chars).toEqual(['😀']);
    const needs = planFamilies(ctx);
    expect(needs).toHaveLength(1);
    expect(needs[0]!.family).toBe('sans');
    expect(needs[0]!.weights).toEqual(new Set(['400']));
    expect(needs[0]!.codePoints).toEqual(new Set(Array.from('😀标签', (char) => char.codePointAt(0)!)));
  });
  it('常用字不报缺字', () => {
    expect(detectFallback(ctxOf(sheetWith(['产品规划', 'v2.0 草稿'])))).toEqual({ chars: [], count: 0 });
  });

  it('emoji 与扩展区汉字被找出来，去重后计数', () => {
    const report = detectFallback(ctxOf(sheetWith(['😀 上线', '𠮷', '再 😀 一次'])));
    expect(report.chars).toEqual(['😀', '𠮷']);
    expect(report.count).toBe(2);
  });

  it('备注里的缺字不报：备注不画在画布上', () => {
    const sheet = sheetWith(['正常']);
    topicAt(sheet, 0).notes = { plain: '😀 只写在备注里', html: '' };
    expect(detectFallback(ctxOf(sheet)).count).toBe(0);
  });

  it('链接文件名只作图标提示，不参与缺字检测与内嵌', () => {
    const sheet = sheetWith(['正常']);
    topicAt(sheet, 0).content = { localLink: { id: 'file-0', name: '😀.txt', data: '', bytes: 0, kind: 'file' } };
    const ctx = ctxOf(sheet);
    const markup = buildExportSvg(ctx);
    expect(markup).toContain('<title>😀.txt</title>');
    expect(detectFallback(ctx).count).toBe(0);
    expect(planFamilies(ctx).some((need) => need.codePoints.has(0x1f600))).toBe(false);
  });

  it('节点字体设成 system 时不报：那本来就是系统字体', () => {
    const sheet = sheetWith(['😀']);
    topicAt(sheet, 0).style = { fontFamily: 'system' };
    expect(detectFallback(ctxOf(sheet)).count).toBe(0);
  });

  it('等宽族下的汉字算缺字（等宽只覆盖拉丁）', () => {
    const sheet = sheetWith(['汉字']);
    topicAt(sheet, 0).style = { fontFamily: 'mono' };
    expect(detectFallback(ctxOf(sheet)).chars).toEqual(['汉', '字']);
  });

  it('边界与关系线标题也检查（它们继承根上的 sans）', () => {
    const sheet = sheetWith(['正常']);
    sheet.boundaries.push({
      id: 'b1',
      title: '😀',
      range: ['t-0'],
      style: {},
    });
    sheet.relationships.push({
      id: 'r1',
      title: '𠮷',
      end1Id: 't-0',
      end2Id: 'root',
      style: {},
    });
    const report = detectFallback(ctxOf(sheet));
    expect(report.chars).toEqual(['😀', '𠮷']);
  });

  it('主题级边界和概要按实际可见文字与字重内嵌', () => {
    const sheet = sheetWith(['正常']);
    sheet.rootTopic.style = { fontFamily: 'system' };
    topicAt(sheet, 0).style = { fontFamily: 'system' };
    sheet.rootTopic.boundaries.push({ id: 'b1', title: '🤖', range: ['t-0'], style: null });
    sheet.rootTopic.summaries.push({ id: 's1', topicId: 'root', range: ['t-0'], title: '😀', style: null });
    const ctx = ctxOf(sheet);
    const markup = buildExportSvg(ctx);
    expect(markup).toMatch(/<text\b[^>]*font-weight:600[^>]*>🤖<\/text>/);
    expect(markup).toMatch(/<text\b[^>]*font-weight:500[^>]*>😀<\/text>/);
    expect(detectFallback(ctx).chars).toEqual(['🤖', '😀']);
    const needs = planFamilies(ctx);
    expect(needs).toHaveLength(1);
    expect(needs[0]!.family).toBe('sans');
    expect(needs[0]!.weights).toEqual(new Set(['600', '500']));
    expect(needs[0]!.codePoints).toEqual(new Set([0x1f916, 0x1f600]));
  });

  it('折叠后代和不显示的注解不参与检测与内嵌', () => {
    const sheet = sheetWith(['正常']);
    const hidden = createTopic({ id: 'hidden', title: '🤖' });
    hidden.labels = ['😀'];
    topicAt(sheet, 0).children.attached.push(hidden);
    topicAt(sheet, 0).collapsed = true;
    sheet.boundaries.push({ id: 'b1', title: '𠮷', range: ['hidden'], style: null });
    sheet.summaries.push({ id: 's1', topicId: 't-0', title: '👽', range: ['hidden'], style: null });
    sheet.relationships.push({ id: 'r1', title: '👾', end1Id: 'hidden', end2Id: 'root', style: null });
    sheet.relationships.push({ id: 'r2', title: '🦄', end1Id: 't-0', end2Id: 'root', style: { lineStyle: 'none' } });
    const ctx = ctxOf(sheet);
    const markup = buildExportSvg(ctx);
    for (const char of Array.from('🤖😀𠮷👽👾🦄')) expect(markup).not.toContain(char);
    expect(detectFallback(ctx).count).toBe(0);
    const codePoints = new Set(planFamilies(ctx).flatMap((need) => [...need.codePoints]));
    for (const char of Array.from('🤖😀𠮷👽👾🦄')) expect(codePoints.has(char.codePointAt(0)!)).toBe(false);
  });

  it('仅收集启用的品牌落款和日期文字', () => {
    const sheet = sheetWith(['正常']);
    sheet.rootTopic.style = { fontFamily: 'system' };
    topicAt(sheet, 0).style = { fontFamily: 'system' };
    const ctx = { ...ctxOf(sheet), brandText: '😀品牌' };
    expect(detectFallback(ctx).count).toBe(0);
    expect(planFamilies(ctx)).toEqual([]);
    const withFooter = { ...ctx, brand: true, date: '2026-10-24' };
    expect(buildExportSvg(withFooter)).toContain('😀品牌</text>');
    expect(detectFallback(withFooter).chars).toEqual(['😀']);
    const needs = planFamilies(withFooter);
    expect(needs).toHaveLength(1);
    expect(needs[0]!.family).toBe('sans');
    expect(needs[0]!.weights).toEqual(new Set(['400']));
    expect(needs[0]!.codePoints).toEqual(new Set(Array.from('2026-10-24😀品牌', (char) => char.codePointAt(0)!)));
  });

  it('只扫导出范围内的画布：多画布选「当前」时不看别张', () => {
    const first = sheetWith(['正常']);
    const second = sheetWith(['😀']);
    second.id = 'sheet-1';
    second.title = '画布 1';

    const doc = createDocument({ title: '测试' });
    doc.sheets = [first, second];

    const current = buildExportContext(doc, 'sheet-0', { ...DEFAULT_EXPORT_OPTIONS, scope: 'current' });
    expect(detectFallback(current).count).toBe(0);

    const all = buildExportContext(doc, 'sheet-0', { ...DEFAULT_EXPORT_OPTIONS, scope: 'all' });
    expect(detectFallback(all).chars).toEqual(['😀']);
  });
});
