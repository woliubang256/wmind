/**
 * 内置模板的构造与文案完整性。
 *
 * 这一组测的是「只有渲染出来才会发现」的错：骨架引用了语言文件里不存在的键、
 * 结构名不在前端支持范围内、文档过不了 `parseDocument`。它们都不会让构建失败，
 * 只会让模板卡片上出现一个原始键名，或者建出一张打不开的图。
 */

import { describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { parseDocument } from '@/editor/model/validate';
import { BUILTIN_TEMPLATES, asStructureClass, buildTemplateDocument } from './builtin';

const STRUCTURES = new Set([
  'mindmap', 'logic-right', 'logic-left', 'org-chart', 'tree-right',
  'timeline', 'fishbone', 'brace', 'tree-table',
]);

/** 收集骨架里用到的所有键，用来比对语言文件。 */
function skeletonKeys(node: { key: string; children?: { key: string; children?: unknown }[] }): string[] {
  const keys = [node.key];
  for (const child of node.children ?? []) {
    keys.push(...skeletonKeys(child as Parameters<typeof skeletonKeys>[0]));
  }
  return keys;
}

describe('内置模板', () => {
  it('默认思维导图模板使用黎明配色和白底中心主题', () => {
    const document = buildTemplateDocument(BUILTIN_TEMPLATES[0]!, i18n.t.bind(i18n));
    expect(document.theme.id).toBe('vivid-dawn');
    expect(document.theme.centralTopic?.fill).toBe('#FFFFFF');
  });
  it('恰好 8 个，且 uid 不重复', () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(8);
    expect(new Set(BUILTIN_TEMPLATES.map((item) => item.uid)).size).toBe(8);
  });

  it.each(BUILTIN_TEMPLATES.map((def) => [def.uid, def] as const))('%s：文档能过 parseDocument', (_uid, def) => {
    const document = buildTemplateDocument(def, i18n.t.bind(i18n));
    const parsed = parseDocument(document);
    expect(parsed.document.sheets).toHaveLength(1);
    expect(parsed.document.sheets[0]?.structure).toBe(def.structure);
    // 标题被归一化成模板名，不是空串。
    expect(parsed.document.title.length).toBeGreaterThan(0);
  });

  it.each(BUILTIN_TEMPLATES.map((def) => [def.uid, def] as const))('%s：结构在前端支持范围内', (_uid, def) => {
    expect(STRUCTURES.has(def.structure)).toBe(true);
    // 配色 id 必须真实存在，否则 themeById 会抛。
    expect(() => buildTemplateDocument(def, i18n.t.bind(i18n))).not.toThrow();
  });

  it.each(BUILTIN_TEMPLATES.map((def) => [def.uid, def] as const))('%s：至少三层，且每层都有文案', (_uid, def) => {
    const document = buildTemplateDocument(def, i18n.t.bind(i18n));
    const root = document.sheets[0]?.rootTopic;
    expect(root?.title.length).toBeGreaterThan(0);
    expect(root?.children.attached.length).toBeGreaterThan(0);
    for (const branch of root?.children.attached ?? []) {
      expect(branch.title.length).toBeGreaterThan(0);
    }
    // 至少有一个分支带子节点——「三层左右」的示例内容。
    const hasGrandchild = (root?.children.attached ?? []).some((branch) => branch.children.attached.length > 0);
    expect(hasGrandchild).toBe(true);
  });

  it('骨架用到的文案键在中英两种语言里都存在', () => {
    const keys = new Set(BUILTIN_TEMPLATES.flatMap((def) => skeletonKeys(def.skeleton)));
    for (const language of ['zh-CN', 'en-US']) {
      for (const key of keys) {
        const value = i18n.getResource(language, 'translation', `templates.sample.${key}`);
        expect(value, `${language} 缺少 templates.sample.${key}`).toBeTruthy();
      }
      for (const def of BUILTIN_TEMPLATES) {
        const value = i18n.getResource(language, 'translation', def.nameKey);
        expect(value, `${language} 缺少 ${def.nameKey}`).toBeTruthy();
      }
    }
  });

  it('占位符被真实数字替换，没有残留的 {{n}}', () => {
    const document = buildTemplateDocument(BUILTIN_TEMPLATES[0]!, i18n.t.bind(i18n));
    const titles: string[] = [];
    const walk = (topic: { title: string; children: { attached: unknown[] } }) => {
      titles.push(topic.title);
      for (const child of topic.children.attached) walk(child as Parameters<typeof walk>[0]);
    };
    walk(document.sheets[0]!.rootTopic);
    expect(titles.some((title) => title.includes('{{n}}'))).toBe(false);
    // 至少有一个标题带上了序号，否则说明占位符根本没被传进去。
    expect(titles.some((title) => /\d/.test(title))).toBe(true);
  });

  it('每次构造都是独立文档（节点 id 不共用）', () => {
    const first = buildTemplateDocument(BUILTIN_TEMPLATES[0]!, i18n.t.bind(i18n));
    const second = buildTemplateDocument(BUILTIN_TEMPLATES[0]!, i18n.t.bind(i18n));
    expect(first.id).not.toBe(second.id);
    expect(first.sheets[0]!.rootTopic.id).not.toBe(second.sheets[0]!.rootTopic.id);
  });

  it('asStructureClass 把不认识的结构退回 mindmap', () => {
    expect(asStructureClass('brace')).toBe('brace');
    expect(asStructureClass('something-new')).toBe('mindmap');
    expect(asStructureClass('')).toBe('mindmap');
  });
});
