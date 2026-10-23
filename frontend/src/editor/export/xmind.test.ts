/**
 * XMind 导出的测试。
 *
 * 主体是**往返**：导出 → 用本项目自己的导入器读回来 → 比对。单看「zip 里有
 * `content.json`」证明不了任何事——字段名写错、range 少一个括号、字号写成 px，
 * 文件在 XMind 里可能打开、也可能悄悄丢内容，而这些都只有读回来才看得见。
 *
 * 导入侧是现成的（`import/xmind/`），拿它当规格说明书比自己再写一份断言可靠：
 * 两边不同步时，往返测试立刻红。
 */

import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { importRegistry } from '../import/builtins';
import { createDocument, createSheet, createTopic } from '../model/create';
import { collectBoundaries, collectSummaries } from '../model/traverse';
import type { WmindDocument } from '../model/types';
import { DEFAULT_EXPORT_OPTIONS, buildExportContext } from './context';
import { buildXmind } from './xmind';

const opts = (patch: Partial<typeof DEFAULT_EXPORT_OPTIONS> = {}) => ({
  ...DEFAULT_EXPORT_OPTIONS,
  ...patch,
});

/** 一张有层级、有中文的图：根 + 两个分支 + 一个叶子。 */
function fixture(): WmindDocument {
  const doc = createDocument({ title: '导出测试' });
  const sheet = createSheet({ id: 'sheet-1', title: '画布 1' });
  sheet.rootTopic = createTopic({ id: 'root', title: '中心主题' });
  const a = createTopic({ id: 'a', title: '分支 A' });
  a.children.attached.push(createTopic({ id: 'a1', title: '叶子 A1' }));
  sheet.rootTopic.children.attached.push(a, createTopic({ id: 'b', title: '分支 B' }));
  doc.sheets = [sheet];
  return doc;
}

function exportThenImport(doc: WmindDocument, patch: Partial<typeof DEFAULT_EXPORT_OPTIONS> = {}, images = new Map<string, string>()) {
  const ctx = buildExportContext(doc, doc.sheets[0]?.id ?? null, opts(patch));
  const result = buildXmind(doc, ctx, images);
  const imported = importRegistry.run({ fileName: '往返.xmind', bytes: result.bytes });
  return { ctx, result, imported, sheet: imported.document.sheets[0]! };
}

/** 直接读 zip 里的某个 JSON 条目，用来断言「写进去的东西长什么样」。 */
function entry(bytes: Uint8Array, name: string): unknown {
  const files = unzipSync(bytes);
  const data = files[name];
  if (data === undefined) throw new Error(`包里没有 ${name}`);
  return JSON.parse(strFromU8(data));
}

describe('XMind 包结构', () => {
  it('三个结构文件齐全，content.json 是画布数组', () => {
    const { result } = exportThenImport(fixture());
    const files = unzipSync(result.bytes);

    expect(Object.keys(files).sort()).toEqual(['content.json', 'manifest.json', 'metadata.json']);

    const content = entry(result.bytes, 'content.json');
    expect(Array.isArray(content)).toBe(true);
    expect((content as unknown[]).length).toBe(1);
  });

  it('metadata 声明了 activeSheetId 与数据结构版本', () => {
    const { result } = exportThenImport(fixture());
    const metadata = entry(result.bytes, 'metadata.json') as Record<string, unknown>;
    expect(metadata.activeSheetId).toBe('sheet-1');
    // 缺了这两项 XMind 会走兼容路径，新版特性（比如 detached）可能被忽略。
    expect(metadata.dataStructureVersion).toBe('2');
    expect(metadata.layoutEngineVersion).toBe('3');
    expect((metadata.creator as Record<string, unknown>).name).toBe('wmind');
  });

  it('主题数与文档一致', () => {
    const { result } = exportThenImport(fixture());
    // root + a + a1 + b
    expect(result.topics).toBe(4);
  });
});

describe('往返：内容与层级', () => {
  it('全画布形状写入所有主题，包括自由主题和折叠后代', () => {
    const doc = fixture();
    doc.sheets[0]!.topicShape = 'ellipse';
    doc.sheets[0]!.rootTopic.children.attached[0]!.collapsed = true;
    doc.sheets[0]!.floatingTopics.push(createTopic({ id: 'floating', title: '自由主题' }));
    const { sheet } = exportThenImport(doc);
    const topics = [sheet.rootTopic, ...sheet.rootTopic.children.attached,
      ...sheet.rootTopic.children.attached[0]!.children.attached, ...sheet.floatingTopics];
    expect(topics).toHaveLength(5);
    expect(topics.every((topic) => topic.style?.shape === 'ellipse')).toBe(true);
  });

  it('联系走向通过 wmindRouting 扩展往返保留', () => {
    const doc = fixture();
    const routing = { start: { x: 100, y: -120 }, end: { x: -100, y: 80 } };
    doc.sheets[0]!.relationships = [{ id: 'r', end1Id: 'a', end2Id: 'b', title: '', style: null, routing }];
    expect(exportThenImport(doc).sheet.relationships[0]!.routing).toEqual(routing);
  });
  it('标题与层级一字不差', () => {
    const { sheet } = exportThenImport(fixture());
    expect(sheet.rootTopic.title).toBe('中心主题');
    expect(sheet.rootTopic.children.attached.map((t) => t.title)).toEqual(['分支 A', '分支 B']);
    expect(sheet.rootTopic.children.attached[0]?.children.attached[0]?.title).toBe('叶子 A1');
  });

  it('节点 id 保持原样（联系与外框靠它指回来）', () => {
    const { sheet } = exportThenImport(fixture());
    expect(sheet.rootTopic.children.attached.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('概要联系在 XMind 往返后仍保留端点身份', () => {
    const doc = fixture();
    doc.sheets[0]!.summaries = [{ id: 'sum-link', topicId: 'root', range: ['a', 'b'], title: '概要', style: null }];
    doc.sheets[0]!.relationships = [{ id: 'rel-sum', end1Id: 'sum-link', end2Id: 'a', title: '', style: null }];
    const { sheet } = exportThenImport(doc);
    expect(sheet.relationships).toHaveLength(1);
    expect(sheet.relationships[0]!.end1Id).toBe('sum-link');
  });

  it('备注、标签、标记、链接、折叠都带过去', () => {
    const doc = fixture();
    const a = doc.sheets[0]!.rootTopic.children.attached[0]!;
    a.content = { todo: true, sticker: 'star', attachments: [{ id: 'f', name: 'a.txt', data: 'YWJj', bytes: 3, kind: 'file' }] };
    a.notes = { plain: '一段备注', html: '<p>一段备注</p>' };
    a.labels = ['重点'];
    a.markers = [{ groupId: 'priority', markerId: 'priority-1' }];
    a.href = 'https://example.test/x';
    a.collapsed = true;

    const { sheet } = exportThenImport(doc);
    const back = sheet.rootTopic.children.attached[0]!;

    expect(back.content).toEqual(a.content);
    expect(back.notes.plain).toBe('一段备注');
    expect(back.labels).toEqual(['重点']);
    expect(back.markers).toEqual([{ groupId: 'priority', markerId: 'priority-1' }]);
    expect(back.href).toBe('https://example.test/x');
    expect(back.collapsed).toBe(true);
  });

  it('自由主题回到画布的自由主题槽位', () => {
    const doc = fixture();
    doc.sheets[0]!.floatingTopics.push(createTopic({ id: 'f1', title: '自由主题' }));

    const { sheet } = exportThenImport(doc);
    expect(sheet.floatingTopics.map((t) => t.title)).toEqual(['自由主题']);
    // 不能同时留在树里——导入侧会把 detached 提上来，重复的话节点会多一份。
    expect(sheet.rootTopic.children.attached.map((t) => t.title)).toEqual(['分支 A', '分支 B']);
  });

  it('结构写在根主题上，读回来仍是那个结构', () => {
    const doc = fixture();
    doc.sheets[0]!.structure = 'logic-right';
    doc.sheets[0]!.rootTopic.structure = 'logic-right';

    const { sheet } = exportThenImport(doc);
    expect(sheet.structure).toBe('logic-right');
  });
});

describe('往返：附属结构', () => {
  it('联系颜色、线宽、线型、虚线和起终点箭头完整往返', () => {
    const doc = fixture();
    const style = { lineColor: '#123456', lineWidth: 4, borderStyle: 'dot', lineStyle: 'elbow', lineStart: 'arrow', lineEnd: 'none' } as const;
    doc.sheets[0]!.relationships.push({ id: 'r', end1Id: 'a', end2Id: 'b', title: '依赖', style });
    const { sheet } = exportThenImport(doc);
    expect(sheet.relationships[0]!.style).toMatchObject(style);
  });
  function annotated(): WmindDocument {
    const doc = fixture();
    const sheet = doc.sheets[0]!;
    sheet.summaries.push({ id: 'sum-1', topicId: 'root', range: ['a', 'b'], title: '小结', style: null });
    sheet.boundaries.push({ id: 'bnd-1', title: '范围', range: ['a'], style: null });
    sheet.relationships.push({ id: 'rel-1', end1Id: 'a', end2Id: 'b', title: '相关', style: null });
    return doc;
  }

  it('概要挂在父主题上，range 指向原来的兄弟节点', () => {
    const { sheet } = exportThenImport(annotated());
    const summaries = collectSummaries(sheet);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.topicId).toBe('root');
    expect(summaries[0]?.range).toEqual(['a', 'b']);
    expect(summaries[0]?.title).toBe('小结');
  });

  it('外框挂在被框节点的父主题上', () => {
    const { sheet } = exportThenImport(annotated());
    const boundaries = collectBoundaries(sheet);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.range).toEqual(['a']);
    expect(boundaries[0]?.title).toBe('范围');
  });

  it('联系两端都指回原节点', () => {
    const { sheet } = exportThenImport(annotated());
    expect(sheet.relationships).toHaveLength(1);
    expect(sheet.relationships[0]?.end1Id).toBe('a');
    expect(sheet.relationships[0]?.end2Id).toBe('b');
    expect(sheet.relationships[0]?.title).toBe('相关');
  });

  it('概要与外框不会既挂在主题上又挂在画布上（否则读回来是两份）', () => {
    const { result, sheet } = exportThenImport(annotated());
    const content = entry(result.bytes, 'content.json') as Record<string, unknown>[];
    const first = content[0]!;

    // 画布级不该再有 summaries / boundaries：它们已经写进主题节点了。
    expect(first.summaries).toBeUndefined();
    expect(first.boundaries).toBeUndefined();
    expect(collectSummaries(sheet)).toHaveLength(1);
    expect(collectBoundaries(sheet)).toHaveLength(1);
  });
});

describe('往返：样式', () => {
  it('显式填充与字号原样回来（字号不会因为 pt/px 换算涨一圈）', () => {
    const doc = fixture();
    const a = doc.sheets[0]!.rootTopic.children.attached[0]!;
    a.style = { fill: '#FF0000', fontSize: 20 };

    const { sheet } = exportThenImport(doc);
    const back = sheet.rootTopic.children.attached[0]!;
    expect(back.style?.fill).toBe('#FF0000');
    expect(back.style?.fontSize).toBe(20);
  });

  it('每个主题都写样式，不留「继承」给 XMind 自己发挥', () => {
    const { result } = exportThenImport(fixture());
    const content = entry(result.bytes, 'content.json') as Record<string, unknown>[];
    const root = (content[0] as Record<string, unknown>).rootTopic as Record<string, unknown>;

    const style = root.style as { properties: Record<string, string> };
    expect(style).toBeDefined();
    // 这四项决定「看起来像不像原图」，任何一项缺失都会让导出图变成一片灰白。
    expect(style.properties['svg:fill']).toBeTruthy();
    expect(style.properties['fo:color']).toBeTruthy();
    expect(style.properties['shape-class']).toMatch(/^org\.xmind\.ui\./);
    expect(style.properties['fo:font-size']).toMatch(/pt$/);
  });

  it('不写 fo:font-family（族标识符不是字体名，硬猜会写出对方机器上没有的字体）', () => {
    const { result } = exportThenImport(fixture());
    const content = entry(result.bytes, 'content.json') as Record<string, unknown>[];
    const root = (content[0] as Record<string, unknown>).rootTopic as Record<string, unknown>;
    const properties = (root.style as { properties: Record<string, string> }).properties;
    expect(properties['fo:font-family']).toBeUndefined();
  });
});

describe('图片内嵌', () => {
  /** 1×1 的透明 PNG。 */
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function withImage(): WmindDocument {
    const doc = fixture();
    doc.sheets[0]!.rootTopic.children.attached[0]!.image = { src: '/uploads/a.png', width: 32, height: 32 };
    return doc;
  }

  it('图片进 resources/，src 换成 xap: 引用', () => {
    const { result, sheet } = exportThenImport(withImage(), {}, new Map([['/uploads/a.png', PNG]]));

    expect(result.images).toBe(1);
    expect(result.skippedImages).toBe(0);

    const files = unzipSync(result.bytes);
    expect(files['resources/image-1.png']).toBeDefined();

    // 读回来时 `imageFromSource` 会去 `resources/` 里找这张图，说明引用写对了。
    // 保留 `xap:` 前缀是刻意的：XMind 就是用它标记「包内资源」。
    expect(sheet.rootTopic.children.attached[0]?.image?.src).toBe('xap:resources/image-1.png');
  });

  it('manifest 列出资源条目（否则 XMind 认为包里有孤儿文件）', () => {
    const { result } = exportThenImport(withImage(), {}, new Map([['/uploads/a.png', PNG]]));
    const manifest = entry(result.bytes, 'manifest.json') as { 'file-entries': Record<string, unknown> };
    expect(Object.keys(manifest['file-entries'])).toContain('resources/image-1.png');
  });

  it('拿不到图片数据时不计入包，并如实报数', () => {
    const { result } = exportThenImport(withImage());
    expect(result.images).toBe(0);
    expect(result.skippedImages).toBe(1);

    const files = unzipSync(result.bytes);
    expect(Object.keys(files).some((name) => name.startsWith('resources/'))).toBe(false);
  });

  it('同一张图被多个节点引用时只存一份', () => {
    const doc = withImage();
    doc.sheets[0]!.rootTopic.children.attached[1]!.image = { src: '/uploads/a.png', width: 32, height: 32 };

    const { result } = exportThenImport(doc, {}, new Map([['/uploads/a.png', PNG]]));
    expect(result.images).toBe(1);
  });
});

describe('画布范围', () => {
  function twoSheets(): WmindDocument {
    const doc = fixture();
    const second = createSheet({ id: 'sheet-2', title: '画布 2' });
    second.rootTopic = createTopic({ id: 'root-2', title: '第二个中心' });
    doc.sheets.push(second);
    return doc;
  }

  it('默认只导当前画布', () => {
    const { result } = exportThenImport(twoSheets());
    expect((entry(result.bytes, 'content.json') as unknown[]).length).toBe(1);
  });

  it('选「全部」时一个文件里装多张画布', () => {
    const { result, imported } = exportThenImport(twoSheets(), { scope: 'all' });
    expect((entry(result.bytes, 'content.json') as unknown[]).length).toBe(2);
    expect(imported.document.sheets.map((s) => s.title)).toEqual(['画布 1', '画布 2']);
  });
});
