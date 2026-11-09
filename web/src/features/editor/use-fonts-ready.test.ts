/**
 * `scanDocument` 的测试。
 *
 * 它决定「注入哪几族的 @font-face」。少算一族不会报错，只会让那族静默退回系统
 * 字体——用户以为「换字体没生效」。所以节点级覆盖、角色样式覆盖、去重这三条都
 * 要有用例钉住。
 */

import { describe, expect, it } from 'vitest';
import { scanDocument } from './use-fonts-ready';
import { docWithTree, topic } from '@/editor/test-utils';

describe('scanDocument', () => {
  it('默认文档只用全局字体', () => {
    const scan = scanDocument(docWithTree());

    expect(scan.families).toEqual(['sans']);
  });

  it('角色样式覆盖也会被算进来', () => {
    const doc = docWithTree();
    doc.theme.centralTopic = { fontFamily: 'serif' };

    expect(scanDocument(doc).families).toEqual(['sans', 'serif']);
  });

  it('节点级字体覆盖也会被算进来（否则那族不会被注入）', () => {
    const doc = docWithTree();
    doc.sheets[0]!.rootTopic.children.attached[0]!.style = { fontFamily: 'mono' };

    expect(scanDocument(doc).families).toEqual(['sans', 'mono']);
  });

  it('自由主题的覆盖同样算', () => {
    const doc = docWithTree();
    doc.sheets[0]!.floatingTopics[0]!.style = { fontFamily: 'serif' };

    expect(scanDocument(doc).families).toEqual(['sans', 'serif']);
  });

  it('同一族重复出现只留一份', () => {
    const doc = docWithTree();
    doc.theme.global.fontFamily = 'serif';
    doc.theme.centralTopic = { fontFamily: 'serif' };
    doc.sheets[0]!.rootTopic.children.attached[0]!.style = { fontFamily: 'serif' };

    expect(scanDocument(doc).families).toEqual(['serif']);
  });

  it('文本收集覆盖所有节点（含自由主题与折叠子树），跳过空标题', () => {
    const doc = docWithTree();
    doc.sheets[0]!.rootTopic.children.attached[1]!.title = '';

    const { text } = scanDocument(doc);

    // 折叠的 a2 也要算：折叠只影响画布可见性，展开后仍要正确测量。
    // B 的标题被清空，所以拼出来的串里只有 B1、没有单独的 B。
    expect(text).toBe('中心主题AA1A2A2XB1自由主题F1X');
  });

  it('多画布一起扫', () => {
    const doc = docWithTree();
    const second = { ...doc.sheets[0]!, id: 'sh-2', rootTopic: topic('root2', '第二画布') };
    second.rootTopic.style = { fontFamily: 'mono' };
    doc.sheets.push(second);

    const scan = scanDocument(doc);

    expect(scan.families).toEqual(['sans', 'mono']);
    expect(scan.text).toContain('第二画布');
  });
});
