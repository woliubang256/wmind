/**
 * XMind 现代格式（content.json）解析的测试。
 *
 * 直接喂 JSON 对象而不是造压缩包：zip 与安全闸门在 `../zip.test.ts` 里已经
 * 单独验过，这里关心的是**映射是否正确**。混在一起会让失败原因变模糊。
 *
 * 夹具按真实 XMind 2020+ 的形态写：`content` 是 sheet 数组、样式挂在
 * `style.properties`、备注分 `plain` / `realHTML` 两段。
 */

import { describe, expect, it } from 'vitest';
import { createImportContext } from '../context';
import { resolveLimits } from '../limits';
import type { ImportContext } from '../types';
import { parseContentJson } from './modern';

function ctxOf(limits: Parameters<typeof resolveLimits>[0] = {}) {
  return createImportContext({ fileName: '团队周会.xmind', limits: resolveLimits(limits) });
}

/** 一份覆盖全部映射分支的夹具。 */
function fixture(): unknown {
  return [
    {
      id: 'sheet-1',
      class: 'sheet',
      title: '画布 1',
      rootTopic: {
        id: 'root',
        class: 'topic',
        title: '中心主题',
        structureClass: 'org.xmind.ui.logic.right',
        children: {
          attached: [
            {
              id: 'a',
              title: '分支 A',
              notes: {
                plain: { content: '备注 A' },
                realHTML: { content: '<p>备注 <b>A</b></p><script>alert(1)</script>' },
              },
              labels: ['标签1', '标签2'],
              markers: [{ markerId: 'priority-1' }, { markerId: 'task-done' }, { markerId: 'sticker-smile' }],
              href: 'https://example.com/a',
              style: {
                id: 's1',
                properties: {
                  'svg:fill': '#FF0000',
                  'shape-class': 'org.xmind.ui.capsule',
                  'fo:font-family': '楷体',
                  'fo:font-size': '12pt',
                  'fo:font-weight': 'bold',
                  'fo:color': '#333333',
                  'line-pattern': 'dash',
                },
              },
              children: { attached: [{ id: 'a1', title: '子 A1' }] },
            },
            { id: 'b', title: '分支 B', collapsed: true },
          ],
          detached: [{ id: 'f1', title: '自由主题' }],
        },
        boundaries: [{ id: 'bd1', range: '(a,b)', title: '外框' }],
        summaries: [{ id: 'sm1', range: '(a,b)', topicId: 'root', title: '概要' }],
      },
      relationships: [{ id: 'rel1', end1Id: 'a', end2Id: 'b', title: '联系' }],
      theme: {
        map: { properties: { 'svg:fill': '#FFFFFF', 'multi-line-colors': '#FF4D6D #FF9F1C #FFD166 #06D6A0 #107FA4 #7B2CBF' } },
        centralTopic: { properties: { 'fo:font-size': '24pt', 'svg:fill': '#FF4D6D' } },
      },
    },
  ];
}

function parse(content: unknown, handle = ctxOf()) {
  return { doc: parseContentJson(content, '团队周会.xmind', handle.context), handle };
}

describe('画布与结构', () => {
  it('读取画布标题与结构', () => {
    const { doc } = parse(fixture());
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0].title).toBe('画布 1');
    expect(doc.sheets[0].structure).toBe('logic-right');
  });

  it('文档标题取文件名', () => {
    // XMind 不存文档级标题，用文件名是唯一不丢信息的来源。
    const { doc } = parse(fixture());
    expect(doc.title).toBe('团队周会');
  });

  it('不认识的结构回退为思维导图并提示', () => {
    const { doc, handle } = parse([
      { title: '画布', rootTopic: { title: '根', structureClass: 'org.xmind.ui.weird.new' } },
    ]);
    expect(doc.sheets[0].structure).toBe('mindmap');
    expect(handle.warnings).toContainEqual({
      code: 'structure-fallback',
      params: { from: 'org.xmind.ui.weird.new' },
    });
  });

  it('顶层写成 {content:[...]} 或 {sheets:[...]} 也认', () => {
    const sheet = { title: '画布', rootTopic: { title: '根' } };
    expect(parseContentJson({ content: [sheet] }, 'x.xmind', ctxOf().context).sheets).toHaveLength(1);
    expect(parseContentJson({ sheets: [sheet] }, 'x.xmind', ctxOf().context).sheets).toHaveLength(1);
  });
});

describe('节点', () => {
  it('递归转换子节点', () => {
    const { doc } = parse(fixture());
    const root = doc.sheets[0].rootTopic;
    expect(root.title).toBe('中心主题');
    expect(root.children.attached.map((t) => t.title)).toEqual(['分支 A', '分支 B']);
    expect(root.children.attached[0].children.attached.map((t) => t.title)).toEqual(['子 A1']);
  });

  it('自由主题提到 floatingTopics', () => {
    // `children.detached` 在布局里拿不到盒子（等于不显示），必须提到自由主题槽位。
    const { doc } = parse(fixture());
    expect(doc.sheets[0].floatingTopics.map((t) => t.title)).toEqual(['自由主题']);
    expect(doc.sheets[0].rootTopic.children.detached).toEqual([]);
  });

  it('折叠状态两种写法都认', () => {
    const { doc } = parse([
      {
        title: '画布',
        rootTopic: {
          title: '根',
          children: {
            attached: [
              { id: 'x', title: 'folded 写法', branch: 'folded' },
              { id: 'y', title: '展开的' },
              { id: 'z', title: 'collapsed 字段', collapsed: true },
            ],
          },
        },
      },
    ]);
    const kids = doc.sheets[0].rootTopic.children.attached;
    expect(kids.map((t) => t.collapsed)).toEqual([true, false, true]);
  });

  it('标题里的控制字符被清掉', () => {
    const { doc } = parse([{ title: '画布', rootTopic: { title: '标题\u0000带\u0007控制符' } }]);
    expect(doc.sheets[0].rootTopic.title).toBe('标题带控制符');
  });

  it('节点数超过上限时抛 TOO_MANY_TOPICS', () => {
    const handle = ctxOf({ maxTopics: 2 });
    const content = [
      {
        title: '画布',
        rootTopic: {
          title: '根',
          children: { attached: [{ title: 'a' }, { title: 'b' }] },
        },
      },
    ];
    try {
      parseContentJson(content, 'x.xmind', handle.context);
      throw new Error('预期抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('TOO_MANY_TOPICS');
    }
  });
});

describe('备注 / 标签 / 标记 / 链接', () => {
  it('备注分纯文本与清洗后的富文本', () => {
    const { doc } = parse(fixture());
    const notes = doc.sheets[0].rootTopic.children.attached[0].notes;
    expect(notes.plain).toBe('备注 A');
    // script 连内容一起被丢掉
    expect(notes.html).toBe('<p>备注 <b>A</b></p>');
  });

  it('标签与超链接直传', () => {
    const { doc } = parse(fixture());
    const a = doc.sheets[0].rootTopic.children.attached[0];
    expect(a.labels).toEqual(['标签1', '标签2']);
    expect(a.href).toBe('https://example.com/a');
  });

  it('标记按分组表映射，不认识的计数提示', () => {
    const { doc, handle } = parse(fixture());
    const a = doc.sheets[0].rootTopic.children.attached[0];
    expect(a.markers).toEqual([
      { groupId: 'priority', markerId: 'priority-1' },
      { groupId: 'task', markerId: 'task-done' },
    ]);
    expect(handle.warnings).toContainEqual({ code: 'marker-unknown', params: { count: 1 } });
  });

  it('图片计入「未能还原」而不是写坏引用', () => {
    // 后端还没有 POST /files，写 xap: 开头的 src 会让画布显示破图。
    const { doc, handle } = parse([
      {
        title: '画布',
        rootTopic: {
          title: '根',
          children: { attached: [{ title: '带图', image: { src: 'xap:resources/a.png', width: 10, height: 10 } }] },
        },
      },
    ]);
    expect(doc.sheets[0].rootTopic.children.attached[0].image).toBeNull();
    expect(handle.warnings).toContainEqual({ code: 'image-skipped', params: { count: 1 } });
  });
});

describe('样式映射', () => {
  it('按 §5.3 的键名映射，字号 pt 换算成 px', () => {
    const { doc } = parse(fixture());
    const style = doc.sheets[0].rootTopic.children.attached[0].style ?? {};
    expect(style.fill).toBe('#FF0000');
    expect(style.shape).toBe('capsule');
    expect(style.fontWeight).toBe(700);
    expect(style.textColor).toBe('#333333');
    expect(style.borderStyle).toBe('dash');
    // 12pt × 4/3 = 16px
    expect(style.fontSize).toBe(16);
  });

  it('字体名归一为标识符并提示（IE-25）', () => {
    const { doc, handle } = parse(fixture());
    const style = doc.sheets[0].rootTopic.children.attached[0].style ?? {};
    expect(style.fontFamily).toBe('serif');
    // 文档里不得残留原始字体名
    expect(JSON.stringify(doc)).not.toContain('楷体');
    expect(handle.warnings).toContainEqual({
      code: 'font-normalized',
      params: { from: '楷体', to: 'serif' },
    });
  });

  it('渐变填充取起始色并提示', () => {
    const { doc, handle } = parse([
      {
        title: '画布',
        rootTopic: {
          title: '根',
          children: {
            attached: [
              {
                title: '渐变',
                style: { properties: { 'svg:fill': '#00FF00', 'svg:fill-pattern': 'gradient' } },
              },
            ],
          },
        },
      },
    ]);
    const style = doc.sheets[0].rootTopic.children.attached[0].style ?? {};
    expect(style.fill).toBe('#00FF00');
    expect(style.fillPattern).toBe('solid');
    expect(handle.warnings).toContainEqual({ code: 'gradient-flattened' });
  });

  it('没有样式时不写任何键（保持继承主题）', () => {
    const { doc } = parse([{ title: '画布', rootTopic: { title: '根', children: { attached: [{ title: 'a' }] } } }]);
    expect(doc.sheets[0].rootTopic.children.attached[0].style).toEqual({});
  });
});

describe('联系 / 外框 / 概要', () => {
  it('三类引用都被还原', () => {
    const { doc } = parse(fixture());
    const sheet = doc.sheets[0];
    expect(sheet.relationships).toHaveLength(1);
    expect(sheet.relationships[0]).toMatchObject({ end1Id: 'a', end2Id: 'b', title: '联系' });

    expect(sheet.rootTopic.boundaries).toHaveLength(1);
    expect(sheet.rootTopic.boundaries[0].range).toEqual(['a', 'b']);

    expect(sheet.rootTopic.summaries).toHaveLength(1);
    expect(sheet.rootTopic.summaries[0]).toMatchObject({ topicId: 'root', range: ['a', 'b'] });
  });

  it('端点缺失的联系被丢弃', () => {
    const { doc } = parse([
      {
        title: '画布',
        rootTopic: { title: '根', children: { attached: [{ id: 'a', title: 'a' }] } },
        relationships: [
          { end1Id: 'a', end2Id: '不存在' },
          { end1Id: 'a', end2Id: 'a' },
        ],
      },
    ]);
    expect(doc.sheets[0].relationships).toEqual([]);
  });

  it('range 支持数组与括号字符串', () => {
    const { doc } = parse([
      {
        title: '画布',
        rootTopic: {
          title: '根',
          children: { attached: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] },
          boundaries: [
            { id: 'b1', range: '(a,b)' },
            { id: 'b2', range: ['a'] },
          ],
        },
      },
    ]);
    const boundaries = doc.sheets[0].rootTopic.boundaries;
    expect(boundaries.map((b) => b.range)).toEqual([['a', 'b'], ['a']]);
  });
});

describe('id 查重', () => {
  it('重复 id 的后来者换新 id，引用指向前者', () => {
    // 复制粘贴产生的同 id 很常见。若交给 parseDocument 查重，它会换掉 id，
    // 引用就指向不存在的老 id 了——所以必须在这里先建映射。
    const { doc } = parse([
      {
        title: '画布',
        rootTopic: {
          title: '根',
          children: {
            attached: [
              { id: 'dup', title: '第一个' },
              { id: 'dup', title: '第二个' },
              { id: 'other', title: '另一个' },
            ],
          },
        },
        relationships: [{ end1Id: 'dup', end2Id: 'other' }],
      },
    ]);
    const [first, second, third] = doc.sheets[0].rootTopic.children.attached;
    expect(first.id).toBe('dup');
    expect(second.id).not.toBe('dup');
    // 引用仍指向第一个同名节点，而不是被换掉 id 的那个
    expect(doc.sheets[0].relationships[0]).toMatchObject({
      end1Id: first.id,
      end2Id: third.id,
    });
  });

  it('缺失 id 的节点也会拿到唯一 id', () => {
    const { doc } = parse([
      { title: '画布', rootTopic: { title: '根', children: { attached: [{ title: 'a' }, { title: 'b' }] } } },
    ]);
    const kids = doc.sheets[0].rootTopic.children.attached;
    expect(kids[0].id).not.toBe('');
    expect(kids[0].id).not.toBe(kids[1].id);
  });
});

describe('主题', () => {
  it('分支色命中内置配色时不回退', () => {
    const { doc, handle } = parse(fixture());
    expect(doc.theme.palette.colors).toEqual([
      '#FF4D6D', '#FF9F1C', '#FFD166', '#06D6A0', '#107FA4', '#7B2CBF',
    ]);
    expect(handle.warnings.some((w) => w.code === 'palette-fallback')).toBe(false);
  });

  it('显式样式叠在配色之上', () => {
    const { doc } = parse(fixture());
    // 主题里 centralTopic 的 24pt → 32px
    expect(doc.theme.centralTopic?.fontSize).toBe(32);
    expect(doc.theme.centralTopic?.fill).toBe('#FF4D6D');
  });

  it('第一张画布的主题升为文档主题，themeOverride 置空', () => {
    const { doc } = parse(fixture());
    expect(doc.sheets[0].themeOverride).toBeNull();
    expect(doc.theme.id).toBe('vivid-entropy');
  });

  it('没有主题时用默认主题，不崩', () => {
    const { doc } = parse([{ title: '画布', rootTopic: { title: '根' } }]);
    expect(doc.theme.id).toBe('classic-rainbow');
  });
});

describe('空内容', () => {
  it('没有画布时返回空 sheets，交给框架判 EMPTY_DOCUMENT', () => {
    const ctx: ImportContext = ctxOf().context;
    expect(parseContentJson([], 'x.xmind', ctx).sheets).toEqual([]);
    expect(parseContentJson({ nothing: true }, 'x.xmind', ctx).sheets).toEqual([]);
  });
});

describe('图片', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function sheetWithImage(image: Record<string, unknown>) {
    return [{ title: '画布', rootTopic: { id: 'root', title: '根', image } }];
  }

  it('包内资源登记成待上传 asset，src 先留占位符', () => {
    const handle = ctxOf();
    const doc = parseContentJson(
      sheetWithImage({ src: 'xap:resources/a.png', width: 200, height: 100 }),
      'x.xmind',
      handle.context,
      new Map([['resources/a.png', bytes]]),
    );

    expect(doc.sheets[0].rootTopic.image).toEqual({ src: 'xap:resources/a.png', width: 200, height: 100 });
    expect(handle.assets).toHaveLength(1);
    expect(handle.assets[0]).toMatchObject({ ref: 'xap:resources/a.png', fileName: 'resources/a.png', mime: 'image/png' });
    expect(handle.assets[0].bytes).toBe(bytes);
  });

  it('条目不在包里时不算 asset，计入 image-skipped', () => {
    const handle = ctxOf();
    const doc = parseContentJson(
      sheetWithImage({ src: 'xap:resources/missing.png' }),
      'x.xmind',
      handle.context,
      new Map(),
    );

    expect(doc.sheets[0].rootTopic.image).toBeNull();
    expect(handle.assets).toEqual([]);
  });

  it('不支持的扩展名（svg）不收', () => {
    const handle = ctxOf();
    const doc = parseContentJson(
      sheetWithImage({ src: 'xap:resources/logo.svg' }),
      'x.xmind',
      handle.context,
      new Map([['resources/logo.svg', bytes]]),
    );

    expect(doc.sheets[0].rootTopic.image).toBeNull();
    expect(handle.assets).toEqual([]);
  });

  it('外链图片直接用，不进上传队列', () => {
    const handle = ctxOf();
    const doc = parseContentJson(
      sheetWithImage({ src: 'https://cdn.test/a.png' }),
      'x.xmind',
      handle.context,
      new Map(),
    );

    expect(doc.sheets[0].rootTopic.image?.src).toBe('https://cdn.test/a.png');
    expect(handle.assets).toEqual([]);
  });

  it('超过 maxAssets 的图片退回「未能还原」，不留占位符', () => {
    const handle = ctxOf({ maxAssets: 1 });
    const resources = new Map([
      ['resources/a.png', bytes],
      ['resources/b.png', bytes],
    ]);
    const doc = parseContentJson(
      [
        {
          title: '画布',
          rootTopic: {
            id: 'root',
            title: '根',
            children: {
              attached: [
                { id: 'a', title: 'A', image: { src: 'xap:resources/a.png' } },
                { id: 'b', title: 'B', image: { src: 'xap:resources/b.png' } },
              ],
            },
          },
        },
      ],
      'x.xmind',
      handle.context,
      resources,
    );

    expect(handle.assets).toHaveLength(1);
    const kids = doc.sheets[0].rootTopic.children.attached;
    expect(kids[0].image?.src).toBe('xap:resources/a.png');
    // 第二张没有进队列，就不能留占位符——否则上传阶段没人认领它。
    expect(kids[1].image).toBeNull();
  });
});
