/**
 * 按主分支拆分导出的测试。
 *
 * 两个重点：
 * 1. **每张图都带中心主题**——只画分支会丢掉「这是哪张导图的哪一支」。
 * 2. **重名分支不能互相覆盖**——zip 里同名条目在多数解压工具里会静默丢掉一个。
 */

import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createDocument, createSheet, createTopic } from '../model/create';
import type { Sheet, WmindDocument } from '../model/types';
import { DEFAULT_EXPORT_OPTIONS } from './context';
import { exportBranches, planBranches, svgEncoder } from './split';

function docWith(titles: string[], rootTitle = '根'): { doc: WmindDocument; sheet: Sheet } {
  const sheet = createSheet({ id: 'sheet-0', title: '画布 0' });
  sheet.rootTopic = createTopic({ id: 'root', title: rootTitle });
  titles.forEach((title, index) => {
    const branch = createTopic({ id: `b-${index}`, title });
    branch.children.attached.push(createTopic({ id: `b-${index}-1`, title: `${title}的子节点` }));
    sheet.rootTopic.children.attached.push(branch);
  });

  const doc = createDocument({ title: '产品规划' });
  doc.sheets = [sheet];
  return { doc, sheet };
}

describe('planBranches', () => {
  it('每个主分支一份计划，文件名取分支标题', () => {
    const { doc } = docWith(['一期', '二期']);
    expect(planBranches(doc, 'sheet-0').map((plan) => plan.title)).toEqual(['一期', '二期']);
  });

  it('每张图都带中心主题，但只挂一个分支', () => {
    const { doc } = docWith(['一期', '二期']);
    for (const plan of planBranches(doc, 'sheet-0')) {
      expect(plan.sheet.rootTopic.title).toBe('根');
      expect(plan.sheet.rootTopic.children.attached).toHaveLength(1);
    }
  });

  it('重名分支加序号，不互相覆盖', () => {
    const { doc } = docWith(['一期', '一期', '一期']);
    expect(planBranches(doc, 'sheet-0').map((plan) => plan.title)).toEqual(['一期', '一期-2', '一期-3']);
  });

  it('标题里的路径字符被去掉，空标题给占位名', () => {
    const { doc } = docWith(['a/b:c', '']);
    expect(planBranches(doc, 'sheet-0').map((plan) => plan.title)).toEqual(['abc', '未命名']);
  });

  it('关系线只保留两端都还在的；游离主题不进分支图', () => {
    const { doc, sheet } = docWith(['一期', '二期']);
    sheet.relationships.push(
      { id: 'r-in', title: '内部', end1Id: 'b-0', end2Id: 'b-0-1', style: null },
      { id: 'r-cross', title: '跨分支', end1Id: 'b-0', end2Id: 'b-1', style: null },
    );
    sheet.floatingTopics.push(createTopic({ id: 'f1', title: '随手记' }));

    const [first] = planBranches(doc, 'sheet-0');
    expect(first!.sheet.relationships.map((item) => item.id)).toEqual(['r-in']);
    expect(first!.sheet.floatingTopics).toEqual([]);
  });

  it('找不到画布时退回第一张；没有画布时返回空', () => {
    const { doc } = docWith(['一期']);
    expect(planBranches(doc, 'missing').map((plan) => plan.title)).toEqual(['一期']);

    const empty = createDocument({ title: '空' });
    empty.sheets = [];
    expect(planBranches(empty, null)).toEqual([]);
  });
});

describe('exportBranches', () => {
  it('SVG 拆分产出可解压的 zip，条目名与分支一致', async () => {
    const { doc } = docWith(['一期', '二期']);
    const result = await exportBranches(doc, 'sheet-0', DEFAULT_EXPORT_OPTIONS, 'svg', {
      encode: svgEncoder,
    });

    expect(result.names).toEqual(['一期.svg', '二期.svg']);

    const files = unzipSync(result.bytes);
    expect(Object.keys(files).sort()).toEqual(['一期.svg', '二期.svg']);

    const first = strFromU8(files['一期.svg']!);
    expect(first.startsWith('<?xml')).toBe(true);
    // 分支图里既有中心主题，也有这个分支
    expect(first).toContain('>根<');
    expect(first).toContain('>一期<');
    // 另一支不该出现
    expect(first).not.toContain('>二期<');
  });

  it('注入的 prepare 会被调用（对话框用它内嵌图片）', async () => {
    const { doc } = docWith(['一期']);
    let prepared = 0;
    await exportBranches(doc, 'sheet-0', DEFAULT_EXPORT_OPTIONS, 'svg', {
      prepare: (ctx) => {
        prepared += 1;
        return ctx;
      },
      encode: svgEncoder,
    });
    expect(prepared).toBe(1);
  });

  it('拆分时 scope 被强制为当前画布', async () => {
    const { doc } = docWith(['一期']);
    const second = createSheet({ id: 'sheet-1', title: '画布 1' });
    second.rootTopic = createTopic({ id: 'root-1', title: '第二张' });
    doc.sheets.push(second);

    const result = await exportBranches(doc, 'sheet-0', { ...DEFAULT_EXPORT_OPTIONS, scope: 'all' }, 'svg', {
      encode: svgEncoder,
    });
    const text = strFromU8(unzipSync(result.bytes)['一期.svg']!);
    expect(text).not.toContain('第二张');
  });

  it('没有分支时产出空 zip 而不是抛错', async () => {
    const { doc } = docWith([]);
    const result = await exportBranches(doc, 'sheet-0', DEFAULT_EXPORT_OPTIONS, 'svg', { encode: svgEncoder });
    expect(result.names).toEqual([]);
    expect(Object.keys(unzipSync(result.bytes))).toEqual([]);
  });
});
