/**
 * 内置适配器清单与**跨格式路由**的测试。
 *
 * 每个适配器自己的测试只验「我认识的文件我认得」；这里验的是它们放在一起时
 * 谁胜出。选错适配器比解析失败更难查：文件「导入成功了」，但内容是错的。
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { BUILTIN_ADAPTERS, importAcceptAttribute, importRegistry } from './builtins';
import { ImportError } from './errors';

const XMIND_CONTENT = [
  {
    id: 'sheet-1',
    class: 'sheet',
    title: '画布 1',
    rootTopic: { id: 'root', title: '中心主题', children: { attached: [{ id: 'a', title: '子' }] } },
  },
];

function xmindBytes(): Uint8Array {
  return zipSync({ 'content.json': strToU8(JSON.stringify(XMIND_CONTENT)) }, { level: 6 });
}

const OPML_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>大纲</title></head>
  <body><outline text="根"><outline text="子"/></outline></body>
</opml>`;

const MARKDOWN_TEXT = '# 甲\n\n## 乙\n\n- 项\n';

function run(fileName: string, text: string) {
  return importRegistry.run({ fileName, bytes: new TextEncoder().encode(text) });
}

function errorOf(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ImportError) return error;
    throw error;
  }
  throw new Error('应当抛错但没有');
}

describe('BUILTIN_ADAPTERS', () => {
  it('三种格式都在清单里', () => {
    expect(BUILTIN_ADAPTERS.map((adapter) => adapter.id)).toEqual(['xmind', 'opml', 'markdown']);
  });

  it('扩展名不重复（否则 accept 里会出现两次）', () => {
    const extensions = BUILTIN_ADAPTERS.flatMap((adapter) => adapter.extensions);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it('accept 属性由扩展名拼出', () => {
    expect(importAcceptAttribute()).toBe('.xmind,.opml,.xml,.md,.markdown');
  });
});

describe('跨格式路由', () => {
  it('xmind 压缩包走 XMind 适配器', () => {
    const result = importRegistry.run({ fileName: 'a.xmind', bytes: xmindBytes() });
    expect(result.format).toBe('xmind');
    expect(result.document.sheets[0]!.rootTopic.title).toBe('中心主题');
  });

  it('OPML 走 OPML 适配器', () => {
    const result = run('a.opml', OPML_TEXT);
    expect(result.format).toBe('opml');
    expect(result.document.sheets[0]!.rootTopic.title).toBe('根');
  });

  it('Markdown 走 Markdown 适配器', () => {
    const result = run('a.md', MARKDOWN_TEXT);
    expect(result.format).toBe('markdown');
    expect(result.document.sheets[0]!.rootTopic.title).toBe('甲');
  });

  it('扩展名写错但内容是 OPML 时仍判为 OPML', () => {
    // 用户从聊天窗口存下来的文件常常叫 `download.md`。
    const result = run('download.md', OPML_TEXT);
    expect(result.format).toBe('opml');
  });

  it('扩展名写错但内容是 Markdown 时仍判为 Markdown', () => {
    const result = run('download.txt', MARKDOWN_TEXT);
    expect(result.format).toBe('markdown');
  });

  it('不认识的二进制内容抛 UNKNOWN_FORMAT', () => {
    const bytes = new Uint8Array(64).fill(0x89);
    const error = errorOf(() => importRegistry.run({ fileName: 'a.bin', bytes }));
    expect(error.code).toBe('UNKNOWN_FORMAT');
  });

  it('是 zip 但不是 XMind 时抛 UNKNOWN_FORMAT，而不是硬当 XMind 解析', () => {
    const bytes = zipSync({ 'readme.txt': strToU8('hello') }, { level: 6 });
    const error = errorOf(() => importRegistry.run({ fileName: 'a.zip', bytes }));
    expect(error.code).toBe('UNKNOWN_FORMAT');
  });
});

describe('导入结果', () => {
  it('三种格式都能通过归一化闸门', () => {
    const results = [
      importRegistry.run({ fileName: 'a.xmind', bytes: xmindBytes() }),
      run('a.opml', OPML_TEXT),
      run('a.md', MARKDOWN_TEXT),
    ];
    for (const result of results) {
      expect(result.warnings.map((warning) => warning.code)).not.toContain('document-normalized');
      expect(result.summary.topics).toBeGreaterThan(0);
      expect(result.document.format).toBe('wmind');
    }
  });

  it('Markdown 的表格降级警告能一路传上来', () => {
    const result = run('a.md', '- 根\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(result.warnings.map((warning) => warning.code)).toContain('table-degraded');
  });
});
