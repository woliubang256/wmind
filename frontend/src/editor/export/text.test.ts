/**
 * Markdown / OPML 导出的测试。
 *
 * 核心不是「输出长得对不对」，而是**能不能被本项目自己的导入器读回来，层级不变**
 * （IE-16 / IE-17）。所以大半用例是「导出 → 导入 → 比对轮廓」，而不是字符串快照。
 */

import { describe, expect, it } from 'vitest';
import { createDocument, createSheet, createTopic } from '../model/create';
import { createImportContext } from '../import/context';
import { resolveLimits } from '../import/limits';
import { parseMarkdown } from '../import/markdown';
import { parseOpml } from '../import/opml';
import type { Sheet, Topic, WmindDocument } from '../model/types';
import { exportMarkdown, exportOpml } from './text';

function sheetWith(children: string[][], rootTitle = '根'): Sheet {
  const sheet = createSheet({ id: 'sheet-0', title: '画布 0' });
  sheet.rootTopic = createTopic({ id: 'root', title: rootTitle });
  children.forEach((path, index) => {
    let parent = sheet.rootTopic;
    path.forEach((title, depth) => {
      const topic = createTopic({ id: `t-${index}-${depth}`, title });
      parent.children.attached.push(topic);
      parent = topic;
    });
  });
  return sheet;
}

function docOf(sheet: Sheet, title = '测试导图'): WmindDocument {
  const doc = createDocument({ title });
  doc.sheets = [sheet];
  return doc;
}

function outline(topic: Topic, depth = 0): string[] {
  const self = `${'  '.repeat(depth)}${topic.title}`;
  return [self, ...topic.children.attached.flatMap((child) => outline(child, depth + 1))];
}

/** 比 `outline` 多带上标签 / 备注 / 折叠：往返用例要证明这些也没丢。 */
function detail(topic: Topic, depth = 0): string[] {
  const tags = [
    ...topic.labels.map((label) => `#${label}`),
    topic.collapsed ? 'collapsed' : '',
    topic.notes.plain === '' ? '' : `note:${topic.notes.plain}`,
  ].filter((tag) => tag !== '');
  const self = `${'  '.repeat(depth)}${topic.title}${tags.length > 0 ? ` [${tags.join(' ')}]` : ''}`;
  return [self, ...topic.children.attached.flatMap((child) => detail(child, depth + 1))];
}

function reimportMarkdown(text: string): Topic {
  const { context } = createImportContext({ fileName: 'x.md', limits: resolveLimits() });
  const doc = parseMarkdown(text, 'x.md', context);
  return doc.sheets[0]!.rootTopic;
}

function reimportOpml(text: string): Topic {
  const { context } = createImportContext({ fileName: 'x.opml', limits: resolveLimits() });
  const doc = parseOpml(text, 'x.opml', context);
  return doc.sheets[0]!.rootTopic;
}

describe('Markdown 导出', () => {
  it('整体形状与 docs/06 §3.6 的示例逐字一致', () => {
    // 手搭而不是用 sheetWith：那个 helper 每条路径建一条链，写不出「一个分支两个子节点」。
    const sheet = createSheet({ id: 'sheet-0', title: '画布 0' });
    const root = createTopic({ id: 'root', title: '产品规划' });
    root.notes = { plain: '2026 年度产品路线', html: '' };

    const phase1 = createTopic({ id: 'p1', title: '一期' });
    const editor = createTopic({ id: 'p1-b', title: '导图编辑器' });
    // createTopic 不接受 labels，只能建好之后补（其它用例也是这么写的）。
    editor.labels = ['核心'];
    phase1.children.attached.push(createTopic({ id: 'p1-a', title: '账号体系' }), editor);
    const phase2 = createTopic({ id: 'p2', title: '二期' });
    phase2.children.attached.push(createTopic({ id: 'p2-a', title: '客户端 App' }));

    root.children.attached.push(phase1, phase2);
    sheet.rootTopic = root;

    expect(exportMarkdown(docOf(sheet), 'sheet-0')).toBe(
      [
        '# 产品规划',
        '',
        '> 2026 年度产品路线',
        '',
        '## 一期',
        '',
        '- 账号体系',
        '- 导图编辑器 `核心`',
        '',
        '## 二期',
        '',
        '- 客户端 App',
        '',
      ].join('\n'),
    );
  });

  it('根用 H1、一级分支用 H2、再往下用列表', () => {
    const doc = docOf(sheetWith([['一期', '账号体系'], ['二期']], '产品规划'));
    const md = exportMarkdown(doc, 'sheet-0');
    expect(md).toContain('# 产品规划');
    expect(md).toContain('## 一期');
    expect(md).toContain('- 账号体系');
    expect(md).toContain('## 二期');
  });

  it('三层以上按缩进嵌套', () => {
    const doc = docOf(sheetWith([['一期', '账号体系', '登录', '短信']], '根'));
    const md = exportMarkdown(doc, 'sheet-0');
    expect(md).toContain('- 账号体系');
    expect(md).toContain('  - 登录');
    expect(md).toContain('    - 短信');
  });

  it('备注写成引用块，跟在节点后面', () => {
    const sheet = sheetWith([['一期']], '根');
    sheet.rootTopic.children.attached[0]!.notes = { plain: '先访谈三位用户', html: '' };
    const md = exportMarkdown(docOf(sheet), 'sheet-0');
    expect(md).toContain('## 一期\n\n> 先访谈三位用户');
  });

  it('链接写成 [标题](href)，标签用反引号', () => {
    const sheet = sheetWith([['一期', '文档']], '根');
    const topic = sheet.rootTopic.children.attached[0]!.children.attached[0]!;
    topic.href = 'https://example.com/doc';
    topic.labels = ['核心'];
    const md = exportMarkdown(docOf(sheet), 'sheet-0');
    expect(md).toContain('- [文档](https://example.com/doc) `核心`');
  });

  // 放在第三层（列表）而不是第二层（`##`）：列表行的行首才是真正会被误读的位置，
  // 标题行本来就是标题，转义在那里证明不了什么。
  it('标题以语法字符开头时转义，读回来还原成原文', () => {
    const sheet = sheetWith([['一期', '# 不是标题', '- 不是列表']], '根');
    const md = exportMarkdown(docOf(sheet), 'sheet-0');
    expect(md).toContain('- \\# 不是标题');
    expect(md).toContain('  - \\- 不是列表');
    expect(outline(reimportMarkdown(md))).toEqual(outline(sheet.rootTopic));
  });

  it('标题里的换行被压成空格（否则读回来多一个节点）', () => {
    const sheet = sheetWith([['一期', '第一行\n第二行']], '根');
    const md = exportMarkdown(docOf(sheet), 'sheet-0');
    expect(md).toContain('- 第一行 第二行');
    // 这里不能比对原文：压平换行本来就会改标题文字。要证明的是「还是一个节点」，
    // 所以直接钉住读回来的轮廓——多一个节点就会多一行。
    expect(outline(reimportMarkdown(md))).toEqual(['根', '  一期', '    第一行 第二行']);
  });

  it('空文档也有一个可用的 H1', () => {
    const doc = createDocument({ title: '空' });
    doc.sheets = [];
    expect(exportMarkdown(doc, null)).toBe('# 空\n');
  });

  it('导出后重新导入，层级与文本一致（IE-16）', () => {
    const sheet = sheetWith([['一期', '账号体系', '登录'], ['二期', '客户端']], '产品规划');
    const original = outline(sheet.rootTopic);
    const md = exportMarkdown(docOf(sheet), 'sheet-0');
    const round = outline(reimportMarkdown(md));
    expect(round).toEqual(original);
  });

  it('只有一级分支的宽树也能往返（不会被判成 list 模式丢根）', () => {
    const sheet = sheetWith([['甲'], ['乙'], ['丙'], ['丁']], '根');
    const original = outline(sheet.rootTopic);
    const round = outline(reimportMarkdown(exportMarkdown(docOf(sheet), 'sheet-0')));
    expect(round).toEqual(original);
  });
});

describe('OPML 导出', () => {
  it('带 XML 声明、head/title 与嵌套 outline', () => {
    const doc = docOf(sheetWith([['一期', '账号体系']], '产品规划'));
    const opml = exportOpml(doc, 'sheet-0');
    expect(opml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(opml).toContain('<head><title>测试导图</title></head>');
    expect(opml).toContain('<outline text="产品规划">');
    expect(opml).toContain('<outline text="一期">');
    expect(opml).toContain('<outline text="账号体系"/>');
  });

  it('备注写进 _note，折叠写进 _collapse', () => {
    const sheet = sheetWith([['一期']], '根');
    const topic = sheet.rootTopic.children.attached[0]!;
    topic.notes = { plain: '先访谈', html: '' };
    topic.collapsed = true;
    const opml = exportOpml(docOf(sheet), 'sheet-0');
    expect(opml).toContain('_note="先访谈"');
    expect(opml).toContain('_collapse="true"');
  });

  it('属性里的 & < " 被转义，不会破坏 XML', () => {
    const doc = docOf(sheetWith([['A & B < C "D"']], '根'));
    const opml = exportOpml(doc, 'sheet-0');
    expect(opml).toContain('text="A &amp; B &lt; C &quot;D&quot;"');
    expect(opml).not.toContain('text="A & B');
  });

  it('导出后重新导入，层级与文本一致（IE-17）', () => {
    const sheet = sheetWith([['一期', '账号体系', '登录'], ['二期']], '产品规划');
    const original = outline(sheet.rootTopic);
    const opml = exportOpml(docOf(sheet), 'sheet-0');
    expect(outline(reimportOpml(opml))).toEqual(original);
  });

  it('标签、备注、折叠状态也往返不丢', () => {
    const sheet = sheetWith([['一期', '账号体系']], '根');
    const topic = sheet.rootTopic.children.attached[0]!.children.attached[0]!;
    topic.labels = ['核心', 'P0'];
    topic.collapsed = true;
    topic.notes = { plain: '先访谈', html: '' };

    const round = reimportOpml(exportOpml(docOf(sheet), 'sheet-0'));
    expect(detail(round)).toEqual(detail(sheet.rootTopic));
  });

  it('游离主题挂在 body 顶层，不被塞进根主题', () => {
    const sheet = sheetWith([['一期']], '根');
    sheet.floatingTopics.push(createTopic({ id: 'f1', title: '随手记' }));
    const opml = exportOpml(docOf(sheet), 'sheet-0');
    // 根主题闭合之后才出现游离主题
    const rootClose = opml.indexOf('  </outline>');
    expect(opml.indexOf('text="随手记"')).toBeGreaterThan(rootClose);
  });
});
