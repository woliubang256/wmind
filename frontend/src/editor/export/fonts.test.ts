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
  return buildExportContext(doc, 'sheet-0', DEFAULT_EXPORT_OPTIONS);
}

function topicAt(sheet: Sheet, index: number): Topic {
  return sheet.rootTopic.children.attached[index]!;
}

describe('detectFallback', () => {
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
