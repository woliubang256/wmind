/**
 * XMind 适配器的端到端测试：真 zip → 注册表 → 文档。
 *
 * 前面的测试都把 `parseContentJson` 直接喂对象，这一组补上「zip 读取 →
 * 格式探测 → 框架闸门」那一段，确保接缝也对。
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { importRegistry } from '../builtins';
import { ImportError } from '../errors';
import { createImportInput, createImportRegistry } from '../registry';
import { resolveLimits } from '../limits';
import { xmindAdapter } from './index';

const CONTENT = [
  {
    id: 'sheet-1',
    title: '画布 1',
    rootTopic: {
      id: 'root',
      title: '中心主题',
      children: { attached: [{ id: 'a', title: '分支 A' }, { id: 'b', title: '分支 B' }] },
    },
  },
];

function xmindZip(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    'content.json': strToU8(JSON.stringify(CONTENT)),
    'metadata.json': strToU8('{}'),
    'manifest.json': strToU8('{}'),
    ...extra,
  });
}

const LEGACY_CONTENT = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">
  <sheet id="s1">
    <topic id="root">
      <title>中心主题</title>
      <children>
        <topics type="attached">
          <topic id="a" style-id="st1"><title>分支 A</title></topic>
          <topic id="b"><title>分支 B</title></topic>
        </topics>
      </children>
    </topic>
  </sheet>
</xmap-content>`;

const LEGACY_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-styles xmlns="urn:xmind:xmap:xmlns:style:2.0" version="2.0">
  <styles>
    <style id="st1" type="topic">
      <topic-properties fill-color="#FFEECC"/>
    </style>
  </styles>
</xmap-styles>`;

function legacyZip(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    'content.xml': strToU8(LEGACY_CONTENT),
    'styles.xml': strToU8(LEGACY_STYLES),
    'meta.xml': strToU8('<meta/>'),
    ...extra,
  });
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

describe('格式探测', () => {
  const registry = createImportRegistry([xmindAdapter]);
  const detect = (fileName: string, bytes: Uint8Array) =>
    registry.detect(createImportInput(fileName, bytes, resolveLimits()))?.id ?? null;

  it('含 content.json 的 zip 判为 XMind（置信度 1）', () => {
    expect(detect('a.xmind', xmindZip())).toBe('xmind');
  });

  it('普通文本不认', () => {
    expect(detect('a.md', strToU8('# 标题'))).toBeNull();
  });

  it('是 zip 但没有结构文件时不认', () => {
    expect(detect('a.xmind', zipSync({ 'meta.xml': strToU8('<meta/>') }))).toBeNull();
  });

  it('含 content.xml 的 zip 判为 XMind 8（置信度 0.95）', () => {
    expect(detect('a.xmind', legacyZip())).toBe('xmind');
  });

  it('两种结构文件都在时现代格式优先', () => {
    const both = zipSync({
      'content.json': strToU8(JSON.stringify(CONTENT)),
      'content.xml': strToU8(LEGACY_CONTENT),
    });
    expect(xmindAdapter.detect(createImportInput('a.xmind', both, resolveLimits()))).toBe(1);
  });
});

describe('端到端导入', () => {
  it('读出画布、节点与摘要', () => {
    const result = importRegistry.run({ fileName: '团队周会.xmind', bytes: xmindZip() });
    expect(result.format).toBe('xmind');
    expect(result.summary).toEqual({ sheets: 1, topics: 3, maxDepth: 2, restored: [] });
    expect(result.document.title).toBe('团队周会');
    expect(result.document.sheets[0].rootTopic.children.attached.map((t) => t.title))
      .toEqual(['分支 A', '分支 B']);
  });

  it('content.json 不是合法 JSON 时抛 PARSE_FAILED', () => {
    const bytes = zipSync({ 'content.json': strToU8('{ 不是 json') });
    expectCode(() => importRegistry.run({ fileName: 'a.xmind', bytes }), 'PARSE_FAILED');
  });

  it('content.json 是空数组时抛 EMPTY_DOCUMENT', () => {
    const bytes = zipSync({ 'content.json': strToU8('[]') });
    expectCode(() => importRegistry.run({ fileName: 'a.xmind', bytes }), 'EMPTY_DOCUMENT');
  });

  it('缩略图与附件不参与解析，但条目名可诊断', () => {
    const bytes = xmindZip({
      'Thumbnails/thumbnail.png': new Uint8Array([1, 2, 3]),
      'resources/a.png': new Uint8Array([4, 5]),
    });
    const result = importRegistry.run({ fileName: 'a.xmind', bytes });
    expect(result.summary.topics).toBe(3);
  });

  it('导入结果能通过归一化闸门（不产生 document-normalized 警告）', () => {
    const result = importRegistry.run({ fileName: 'a.xmind', bytes: xmindZip() });
    expect(result.warnings.map((w) => w.code)).not.toContain('document-normalized');
  });

  it('XMind 8：zip → content.xml + styles.xml → 文档', () => {
    const result = importRegistry.run({ fileName: '旧版.xmind', bytes: legacyZip() });
    expect(result.format).toBe('xmind');
    expect(result.summary).toEqual({ sheets: 1, topics: 3, maxDepth: 2, restored: ['style'] });
    expect(result.document.sheets[0]?.rootTopic.children.attached[0]?.style?.fill).toBe('#FFEECC');
  });

  it('XMind 8：styles.xml 缺失也能导入', () => {
    const bytes = zipSync({ 'content.xml': strToU8(LEGACY_CONTENT) });
    const result = importRegistry.run({ fileName: '旧版.xmind', bytes });
    expect(result.summary.topics).toBe(3);
  });

  it('XMind 8：content.xml 结构错误时抛 PARSE_FAILED', () => {
    const bytes = zipSync({ 'content.xml': strToU8('<xmap-content><sheet></xmap-content>') });
    expectCode(() => importRegistry.run({ fileName: 'a.xmind', bytes }), 'PARSE_FAILED');
  });

  it('XMind 8：没有 sheet 时抛 EMPTY_DOCUMENT', () => {
    const bytes = zipSync({ 'content.xml': strToU8('<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"/>') });
    expectCode(() => importRegistry.run({ fileName: 'a.xmind', bytes }), 'EMPTY_DOCUMENT');
  });
});
