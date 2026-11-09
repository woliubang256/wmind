import { describe, expect, it } from 'vitest';
import { DocumentParseError, isWmindDocument, parseDocument } from './validate';
import { createDocument } from './create';

/** 一份「最小但合法」的文档，测试在它上面做局部破坏。 */
function minimal(): Record<string, unknown> {
  return {
    format: 'wmind',
    formatVersion: '1.0',
    id: 'doc-1',
    title: '测试',
    theme: { id: 't', name: 'T' },
    sheets: [
      {
        id: 'sh-1',
        title: '画布 1',
        structure: 'mindmap',
        rootTopic: { id: 'root', title: '根' },
      },
    ],
    meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', app: 'wmind/1.0.0' },
    extensions: [],
  };
}

describe('parseDocument 硬失败', () => {
  it('非对象直接抛错', () => {
    expect(() => parseDocument(null)).toThrow(DocumentParseError);
    expect(() => parseDocument('{}')).toThrow(DocumentParseError);
    expect(() => parseDocument([])).toThrow(DocumentParseError);
  });

  it('format 不匹配抛错', () => {
    expect(() => parseDocument({ ...minimal(), format: 'xmind' })).toThrow(/format/);
  });

  it('major 版本更高时抛错', () => {
    expect(() => parseDocument({ ...minimal(), formatVersion: '2.0' })).toThrow(/版本/);
  });

  it('minor 版本更高时接受（向前兼容）', () => {
    const result = parseDocument({ ...minimal(), formatVersion: '1.7' });
    expect(result.document.formatVersion).toBe('1.0');
  });
});

describe('parseDocument 归一化', () => {
  it('联系走向原生往返保留，非有限控制点退回自动', () => {
    const doc = createDocument();
    const routing = { start: { x: 20, y: -50 }, end: { x: -20, y: 50 } };
    doc.sheets[0]!.relationships = [{ id: 'r', end1Id: 'a', end2Id: 'b', title: '', style: null, routing }];
    expect(parseDocument(JSON.parse(JSON.stringify(doc))).document.sheets[0]!.relationships[0]!.routing).toEqual(routing);
    doc.sheets[0]!.relationships[0]!.routing!.start.x = NaN;
    expect(parseDocument(doc).document.sheets[0]!.relationships[0]!.routing).toBeUndefined();
  });
  it('补齐缺失的字段', () => {
    const { document } = parseDocument({
      format: 'wmind',
      formatVersion: '1.0',
      sheets: [{ rootTopic: { title: '只有标题' } }],
    });

    expect(document.title).toBe('未命名导图');
    expect(document.id).not.toBe('');
    expect(document.sheets).toHaveLength(1);
    const root = document.sheets[0]!.rootTopic;
    expect(root.title).toBe('只有标题');
    expect(root.children.attached).toEqual([]);
    expect(root.notes).toEqual({ plain: '', html: '' });
    expect(root.collapsed).toBe(false);
    expect(root.labels).toEqual([]);
    expect(document.meta.createdAt).not.toBe('');
  });

  it('没有画布时补一张并留警告', () => {
    const { document, warnings } = parseDocument({ ...minimal(), sheets: [] });
    expect(document.sheets).toHaveLength(1);
    expect(warnings.some((w) => w.includes('没有任何画布'))).toBe(true);
  });

  it('重复 id 会重新生成并留警告', () => {
    const input = minimal();
    (input.sheets as Record<string, unknown>[])[0]!.rootTopic = {
      id: 'dup',
      title: '根',
      children: { attached: [{ id: 'dup', title: '子' }] },
    };

    const { document, warnings } = parseDocument(input);
    const root = document.sheets[0]!.rootTopic;
    const child = root.children.attached[0]!;
    expect(root.id).toBe('dup');
    expect(child.id).not.toBe('dup');
    expect(warnings.some((w) => w.includes('重复'))).toBe(true);
  });

  it('非法枚举回退并留警告', () => {
    const input = minimal();
    (input.sheets as Record<string, unknown>[])[0]!.structure = 'spiral';

    const { document, warnings } = parseDocument(input);
    expect(document.sheets[0]!.structure).toBe('mindmap');
    expect(warnings.some((w) => w.includes('spiral'))).toBe(true);
  });

  it('非法颜色回退，null 保留为「无填充」', () => {
    const input = minimal();
    (input.sheets as Record<string, unknown>[])[0]!.rootTopic = {
      id: 'root',
      title: '根',
      style: { fill: null, borderColor: 'javascript:alert(1)' },
    };

    const { document, warnings } = parseDocument(input);
    const style = document.sheets[0]!.rootTopic.style!;
    expect(style.fill).toBeNull();
    expect(style.borderColor).toBe('#000000');
    expect(warnings.some((w) => w.includes('borderColor'))).toBe(true);
  });

  it('fontWeight 归一到 100 的整数倍并夹在 100..900', () => {
    const input = minimal();
    (input.sheets as Record<string, unknown>[])[0]!.rootTopic = {
      id: 'root',
      title: '根',
      style: { fontWeight: 437 },
    };
    const { document } = parseDocument(input);
    expect(document.sheets[0]!.rootTopic.style!.fontWeight).toBe(400);

    (input.sheets as Record<string, unknown>[])[0]!.rootTopic = {
      id: 'root',
      title: '根',
      style: { fontWeight: 5000 },
    };
    expect(parseDocument(input).document.sheets[0]!.rootTopic.style!.fontWeight).toBe(900);
  });

  it('调色板为空时回落到内置色板（否则取色会得到 undefined）', () => {
    const { document } = parseDocument({ ...minimal(), theme: { palette: { colors: [], lineColors: [] } } });
    expect(document.theme.palette.colors.length).toBeGreaterThan(0);
    expect(document.theme.palette.lineColors.length).toBeGreaterThan(0);
  });

  it('端点缺失或相同的关系被丢弃', () => {
    const input = minimal();
    (input.sheets as Record<string, unknown>[])[0]!.relationships = [
      { id: 'r1', end1Id: 'a', end2Id: 'a' },
      { id: 'r2', end1Id: 'a' },
      { id: 'r3', end1Id: 'a', end2Id: 'b', title: '依赖' },
    ];
    const { document } = parseDocument(input);
    expect(document.sheets[0]!.relationships.map((r) => r.id)).toEqual(['r3']);
  });

  it('联系的起终点箭头样式经原生文档解析仍保留', () => {
    const input = minimal();
    (input.sheets as Record<string, unknown>[])[0]!.relationships = [{ id: 'r', end1Id: 'a', end2Id: 'b', style: { lineStart: 'arrow', lineEnd: 'none', lineColor: '#123456' } }];
    const { document } = parseDocument(JSON.parse(JSON.stringify(input)));
    expect(document.sheets[0]!.relationships[0]!.style).toEqual({ lineStart: 'arrow', lineEnd: 'none', lineColor: '#123456' });
  });

  it('空范围 / 空挂载点的 boundary 与 summary 被丢弃', () => {
    const input = minimal();
    (input.sheets as Record<string, unknown>[])[0]!.boundaries = [{ id: 'b1', range: [] }];
    (input.sheets as Record<string, unknown>[])[0]!.summaries = [{ id: 's1', topicId: '', range: ['x'] }];
    const { document } = parseDocument(input);
    expect(document.sheets[0]!.boundaries).toEqual([]);
    expect(document.sheets[0]!.summaries).toEqual([]);
  });

  it('meta 缺失时用当前时间兜底', () => {
    const { document } = parseDocument({ ...minimal(), meta: undefined });
    expect(Number.isNaN(Date.parse(document.meta.createdAt))).toBe(false);
  });
});

describe('往返', () => {
  it('createDocument 的产物能被 parseDocument 原样读回', () => {
    const original = createDocument({ title: '往返' });
    original.sheets[0]!.rootTopic.children.attached.push(
      createDocument({ title: 'x' }).sheets[0]!.rootTopic,
    );

    const { document, warnings } = parseDocument(JSON.parse(JSON.stringify(original)));
    expect(warnings).toEqual([]);
    expect(document.title).toBe('往返');
    expect(document.sheets[0]!.rootTopic.children.attached).toHaveLength(1);
  });

  it('isWmindDocument 只做形状判断', () => {
    expect(isWmindDocument(minimal())).toBe(true);
    expect(isWmindDocument({ format: 'wmind' })).toBe(false);
    expect(isWmindDocument({ sheets: [] })).toBe(false);
  });
});
