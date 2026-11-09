/**
 * 纯文本适配器的**探测**测试。
 *
 * 探测分数决定「谁来解析这个文件」，选错了比解析失败更糟：一个 `<opml>` 文件
 * 被 Markdown 抢走，会变成一堆带尖括号的空节点，用户看不出哪里错了。所以
 * 这里逐条钉住优先级：
 *
 * - zip 一律 0（那是 XMind 的地盘）；
 * - `<opml>` 头部 0.95，必须高于 Markdown 内容推断的上限 0.8；
 * - 扩展名是最强信号，`.md` 里只有一行散文也仍然是 Markdown；
 * - XML / HTML 头部一律不当 Markdown。
 */

import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import { resolveLimits } from './limits';
import { createImportContext } from './context';
import { createImportInput } from './registry';
import { markdownAdapter, opmlAdapter } from './text-adapters';

const LIMITS = resolveLimits();

function inputOf(fileName: string, text: string) {
  return createImportInput(fileName, new TextEncoder().encode(text), LIMITS);
}

function scoreOf(adapter: typeof markdownAdapter, fileName: string, text: string): number {
  return adapter.detect(inputOf(fileName, text));
}

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>大纲</title></head>
  <body>
    <outline text="根"><outline text="子"/></outline>
  </body>
</opml>`;

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('markdownAdapter.detect', () => {
  it('扩展名 .md 即使内容只有一行散文也认', () => {
    expect(scoreOf(markdownAdapter, 'notes.md', '随便写点东西\n')).toBe(0.75);
    expect(scoreOf(markdownAdapter, 'notes.markdown', '随便写点东西\n')).toBe(0.75);
  });

  it('标题 + 列表 + 链接累加，上限 0.8', () => {
    const rich = '# 标题\n- 项目\n1. 有序\n[链接](https://a.b)\n';
    expect(scoreOf(markdownAdapter, 'untitled', rich)).toBe(0.8);
  });

  it('只有列表时分数低于纯标题', () => {
    const list = '- a\n- b\n';
    const heading = '# a\n# b\n';
    expect(scoreOf(markdownAdapter, 'untitled', list)).toBeLessThan(
      scoreOf(markdownAdapter, 'untitled', heading),
    );
  });

  it('zip 一律 0 分', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    const input = createImportInput('a.md', zip, LIMITS);
    expect(markdownAdapter.detect(input)).toBe(0);
  });

  it('XML / HTML 头部不判成 Markdown', () => {
    for (const head of ['<?xml version="1.0"?>\n<opml/>', '<html><body>x</body></html>']) {
      expect(scoreOf(markdownAdapter, 'page.md', head)).toBe(0);
    }
  });

  it('空内容得 0 分（没有扩展名时）', () => {
    expect(scoreOf(markdownAdapter, 'blob', '')).toBe(0);
  });

  it('大小写扩展名都认', () => {
    expect(scoreOf(markdownAdapter, 'README.MD', 'x')).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// OPML
// ---------------------------------------------------------------------------

describe('opmlAdapter.detect', () => {
  it('<opml> 头部得 0.95，高于 Markdown 的上限 0.8', () => {
    const score = scoreOf(opmlAdapter, 'untitled', OPML);
    expect(score).toBe(0.95);
    expect(score).toBeGreaterThan(0.8);
  });

  it('扩展名 .opml / .xml 得 0.7', () => {
    expect(scoreOf(opmlAdapter, 'x.opml', 'not xml at all')).toBe(0.7);
    expect(scoreOf(opmlAdapter, 'x.xml', 'not xml at all')).toBe(0.7);
  });

  it('zip 一律 0 分', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(opmlAdapter.detect(createImportInput('a.opml', zip, LIMITS))).toBe(0);
  });

  it('无关文件得 0 分', () => {
    expect(scoreOf(opmlAdapter, 'notes.md', '# 标题\n')).toBe(0);
  });
});

describe('两个适配器的优先级', () => {
  it('OPML 文件的 Markdown 分数低于 OPML 分数', () => {
    // 正文里也可能有 `#`（比如 outline 的 text 里有），但 opml 仍应胜出。
    const opmlWithHash = OPML.replace('text="根"', 'text="# 根"');
    expect(scoreOf(opmlAdapter, 'a.opml', opmlWithHash)).toBeGreaterThan(
      scoreOf(markdownAdapter, 'a.opml', opmlWithHash),
    );
  });

  it('Markdown 文件的 OPML 分数为 0', () => {
    const md = '# 标题\n\n- a\n- b\n';
    expect(scoreOf(opmlAdapter, 'a.md', md)).toBe(0);
    expect(scoreOf(markdownAdapter, 'a.md', md)).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe('parse', () => {
  it('Markdown 适配器走文本入口', () => {
    const { context } = createImportContext({ fileName: 'a.md', limits: LIMITS });
    const doc = markdownAdapter.parse(inputOf('a.md', '# 甲\n\n## 乙\n'), context);
    expect(doc.sheets[0]!.rootTopic.title).toBe('甲');
  });

  it('OPML 适配器把 XmlParseError 收口成 PARSE_FAILED', () => {
    const { context } = createImportContext({ fileName: 'a.opml', limits: LIMITS });
    const broken = inputOf('a.opml', '<opml><body><outline text="a"></body></opml>');
    try {
      opmlAdapter.parse(broken, context);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('PARSE_FAILED');
      // 原始异常要留着，否则排查时看不出是哪一行坏了。
      expect((error as ImportError).cause).toBeInstanceOf(Error);
    }
  });

  it('OPML 适配器对空文档返回空 sheets，交给框架判 EMPTY_DOCUMENT', () => {
    const { context } = createImportContext({ fileName: 'a.opml', limits: LIMITS });
    const doc = opmlAdapter.parse(inputOf('a.opml', '<opml version="2.0"><body/></opml>'), context);
    expect(doc.sheets).toEqual([]);
  });
});
