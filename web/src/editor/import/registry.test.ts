/**
 * 注册表与执行入口的测试。
 *
 * 用假适配器而不是真 XMind 样本：这里要验证的是**框架的闸门**，不是某个格式
 * 的解析正确性。假适配器可以精确制造「产出空文档」「忘调 ctx.topic()」
 * 「返回非法枚举」这些真实适配器很难稳定复现的坏情况。
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createDocument, createTopic } from '../model/create';
import type { WmindDocument } from '../model/types';
import { ImportError } from './errors';
import type { ImportLimits } from './limits';
import { createImportRegistry } from './registry';
import { summarizeImport } from './summary';
import type { ImportAdapter, ImportInput, ImportResult } from './types';

/** 造一份有 n 个节点的文档（1 个中心 + n-1 个子节点）。 */
function docWith(topics: number, mutate?: (doc: WmindDocument) => void): WmindDocument {
  const doc = createDocument({ title: '样本' });
  const root = doc.sheets[0].rootTopic;
  for (let i = 0; i < topics - 1; i += 1) {
    root.children.attached.push(createTopic({ title: `子 ${i + 1}` }));
  }
  mutate?.(doc);
  return doc;
}

/** 总是返回同一份文档的适配器。 */
function adapterReturning(
  document: WmindDocument | (() => WmindDocument),
  id: ImportAdapter['id'] = 'xmind',
  score = 1,
): ImportAdapter {
  return {
    id,
    extensions: ['xmind'],
    detect: () => score,
    parse: () => (typeof document === 'function' ? document() : document),
  };
}

function expectCode(fn: () => unknown, code: string): ImportError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe(code);
    return error as ImportError;
  }
  throw new Error(`预期抛出 ${code}，但什么都没抛`);
}

const BYTES = strToU8('placeholder');

function run(adapter: ImportAdapter, bytes: Uint8Array = BYTES, limits?: Partial<ImportLimits>) {
  return createImportRegistry([adapter]).run({ fileName: 'sample.xmind', bytes, limits });
}

describe('格式探测', () => {
  it('取置信度最高的适配器', () => {
    const low: ImportAdapter = { ...adapterReturning(docWith(1), 'markdown', 0.3) };
    const high: ImportAdapter = { ...adapterReturning(docWith(1), 'opml', 0.9) };
    const registry = createImportRegistry([low, high]);
    const input = { fileName: 'x', size: 1, bytes: BYTES, zip: () => null, text: () => '' };
    expect(registry.detect(input)?.id).toBe('opml');
  });

  it('分数并列时保留先注册的，结果稳定', () => {
    const first: ImportAdapter = { ...adapterReturning(docWith(1), 'markdown', 0.5) };
    const second: ImportAdapter = { ...adapterReturning(docWith(1), 'opml', 0.5) };
    const registry = createImportRegistry([first, second]);
    const input = { fileName: 'x', size: 1, bytes: BYTES, zip: () => null, text: () => '' };
    expect(registry.detect(input)?.id).toBe('markdown');
  });

  it('同 id 注册两次是覆盖而不是并存', () => {
    const registry = createImportRegistry();
    registry.register(adapterReturning(docWith(1), 'xmind', 0.2));
    registry.register(adapterReturning(docWith(1), 'xmind', 0.8));
    expect(registry.list()).toHaveLength(1);
  });
});

describe('失败闸门', () => {
  it('没有适配器认识时抛 UNKNOWN_FORMAT', () => {
    const registry = createImportRegistry([]);
    expectCode(
      () => registry.run({ fileName: 'a.bin', bytes: BYTES }),
      'UNKNOWN_FORMAT',
    );
  });

  it('文件超限抛 FILE_TOO_LARGE，且不进入适配器', () => {
    let parsed = false;
    const adapter: ImportAdapter = {
      id: 'markdown',
      extensions: ['md'],
      detect: () => 1,
      parse: () => {
        parsed = true;
        return docWith(1);
      },
    };
    expectCode(
      () => createImportRegistry([adapter]).run({ fileName: 'a.md', bytes: BYTES, limits: { maxInputBytes: 4 } }),
      'FILE_TOO_LARGE',
    );
    expect(parsed).toBe(false);
  });

  it('适配器抛 ImportError 时原样透传，不被包成 PARSE_FAILED', () => {
    const adapter: ImportAdapter = {
      id: 'xmind',
      extensions: ['xmind'],
      detect: () => 1,
      parse: () => {
        throw new ImportError('ENCRYPTED');
      },
    };
    expectCode(() => run(adapter), 'ENCRYPTED');
  });

  it('适配器抛普通异常时收口成 PARSE_FAILED 并保留 cause', () => {
    const boom = new SyntaxError('Unexpected token');
    const adapter: ImportAdapter = {
      id: 'xmind',
      extensions: ['xmind'],
      detect: () => 1,
      parse: () => {
        throw boom;
      },
    };
    const error = expectCode(() => run(adapter), 'PARSE_FAILED');
    expect((error.cause as Error).message).toBe('Unexpected token');
  });

  it('适配器产出零画布时抛 EMPTY_DOCUMENT', () => {
    const adapter = adapterReturning(docWith(1, (doc) => { doc.sheets = []; }));
    expectCode(() => run(adapter), 'EMPTY_DOCUMENT');
  });

  it('ctx.topic() 超限时抛 TOO_MANY_TOPICS', () => {
    const adapter: ImportAdapter = {
      id: 'xmind',
      extensions: ['xmind'],
      detect: () => 1,
      parse: (_input, ctx) => {
        for (let i = 0; i < 5; i += 1) ctx.topic();
        return docWith(1);
      },
    };
    expectCode(
      () => createImportRegistry([adapter]).run({ fileName: 'a.xmind', bytes: BYTES, limits: { maxTopics: 3 } }),
      'TOO_MANY_TOPICS',
    );
  });

  it('适配器忘调 ctx.topic() 时，按最终文档兜底拦截', () => {
    // 这是最危险的情形：适配器不配合，计数器永远是 0，上限形同虚设。
    const adapter = adapterReturning(docWith(50));
    expectCode(
      () => createImportRegistry([adapter]).run({ fileName: 'a.xmind', bytes: BYTES, limits: { maxTopics: 10 } }),
      'TOO_MANY_TOPICS',
    );
  });
});

describe('归一化闸门', () => {
  it('修补非法枚举并留下 document-normalized 警告', () => {
    const adapter = adapterReturning(docWith(1, (doc) => {
      doc.sheets[0].rootTopic.titleFormat = 'weird' as never;
    }));
    const result: ImportResult = run(adapter);
    expect(result.document.sheets[0].rootTopic.titleFormat).toBe('plain');
    expect(result.warnings.map((w) => w.code)).toContain('document-normalized');
  });

  it('文档正常时不产生归一化警告', () => {
    const result = run(adapterReturning(docWith(3)));
    expect(result.warnings).toEqual([]);
  });

  it('标题被截断时汇总成一条带 count 的警告', () => {
    const adapter: ImportAdapter = {
      id: 'markdown',
      extensions: ['md'],
      detect: () => 1,
      parse: (_input, ctx) => docWith(3, (doc) => {
        doc.sheets[0].rootTopic.title = ctx.title('很长'.repeat(2000));
        doc.sheets[0].rootTopic.children.attached[0].title = ctx.title('很长'.repeat(2000));
      }),
    };
    const result = run(adapter);
    const warning = result.warnings.find((w) => w.code === 'title-truncated');
    expect(warning?.params?.count).toBe(2);
    // 只出现一条，不是每条一个
    expect(result.warnings.filter((w) => w.code === 'title-truncated')).toHaveLength(1);
  });
});

describe('结果结构', () => {
  it('带上格式、摘要与不支持项', () => {
    const adapter: ImportAdapter = {
      id: 'xmind',
      extensions: ['xmind'],
      detect: () => 1,
      parse: (_input, ctx) => {
        ctx.unsupported('sticker', 3);
        ctx.warn('palette-fallback');
        return docWith(4, (doc) => {
          doc.sheets[0].rootTopic.notes.plain = '备注';
        });
      },
    };
    const result = run(adapter);
    expect(result.format).toBe('xmind');
    expect(result.summary).toEqual({
      sheets: 1,
      topics: 4,
      maxDepth: 2,
      restored: ['notes'],
    });
    expect(result.unsupported).toEqual({ sticker: 3 });
    expect(result.warnings).toEqual([{ code: 'palette-fallback' }]);
  });
});

describe('输入惰性化', () => {
  it('zip 文件只在调用 zip() 时才解压，text() 照常可用', () => {
    const bytes = zipSync({ 'content.json': strToU8('{"hello":1}') });
    let zipped = 0;
    const adapter: ImportAdapter = {
      id: 'xmind',
      extensions: ['xmind'],
      detect: () => 1,
      parse: (input: ImportInput) => {
        const zip = input.zip();
        expect(zip).not.toBeNull();
        zipped += 1;
        expect(zip?.text('content.json')).toBe('{"hello":1}');
        // 第二次取用的是缓存，不会重复解压
        expect(input.zip()).toBe(zip);
        return docWith(1);
      },
    };
    const result = run(adapter, bytes);
    expect(result.format).toBe('xmind');
    expect(zipped).toBe(1);
  });

  it('非 zip 输入下 zip() 返回 null 而不是抛错', () => {
    const adapter: ImportAdapter = {
      id: 'markdown',
      extensions: ['md'],
      detect: () => 1,
      parse: (input) => {
        expect(input.zip()).toBeNull();
        expect(input.text()).toBe('placeholder');
        return docWith(1);
      },
    };
    expect(run(adapter).format).toBe('markdown');
  });
});

describe('summarizeImport', () => {
  it('统计画布、节点、层数', () => {
    const doc = createDocument();
    const child = createTopic({ title: '子' });
    child.children.attached.push(createTopic({ title: '孙' }));
    doc.sheets[0].rootTopic.children.attached.push(child);
    doc.sheets[0].floatingTopics.push(createTopic({ title: '自由' }));

    expect(summarizeImport(doc)).toEqual({
      sheets: 1,
      topics: 4,
      maxDepth: 3,
      restored: [],
    });
  });

  it('逐项识别已还原的能力', () => {
    const doc = docWith(1, (d) => {
      const root = d.sheets[0].rootTopic;
      root.notes.plain = '备注';
      root.labels = ['标签'];
      root.markers = [{ groupId: 'task', markerId: 'done' }];
      root.href = 'https://example.com';
      root.image = { src: 'https://example.com/a.png', width: 10, height: 10 };
      root.collapsed = true;
      root.structure = 'org-chart';
      root.style = { fill: '#ff0000' };
      d.sheets[0].relationships.push({ id: 'r1', end1Id: root.id, end2Id: root.id, title: '', style: null });
      d.sheets[0].boundaries.push({ id: 'b1', title: '', range: [root.id], style: null });
      d.sheets[0].summaries.push({ id: 's1', topicId: root.id, range: [root.id], title: '', style: null });
    });

    expect(summarizeImport(doc).restored).toEqual([
      'structure',
      'style',
      'notes',
      'labels',
      'markers',
      'href',
      'image',
      'relationships',
      'boundaries',
      'summaries',
      'collapsed',
    ]);
  });
});
