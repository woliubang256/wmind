/**
 * OPML 导入的测试。
 *
 * OPML 几乎没有「判断」，所以这里的重点是三条约定：
 *
 * 1. 多个根 `<outline>`：第一个是中心主题，其余是**自由主题**（不是丢弃，
 *    也不是硬塞成子节点）——docs/06 §2.3；
 * 2. `text` 缺失回退 `title`，两者都缺写 `(未命名)`（空标题节点在画布上是个
 *    看不见的空框，比占位符更让人困惑）；
 * 3. 「没有内容」与「XML 坏了」是两种失败：前者返回空 sheets 交给框架判
 *    `EMPTY_DOCUMENT`，后者抛 `XmlParseError`。
 */

import { describe, expect, it } from 'vitest';
import { createImportContext } from './context';
import { resolveLimits } from './limits';
import { parseOpml } from './opml';
import type { Topic } from '../model/types';

function ctxOf(fileName = '大纲.opml') {
  const handle = createImportContext({ fileName, limits: resolveLimits() });
  return { handle, ctx: handle.context };
}

function parse(xml: string, fileName = '大纲.opml') {
  const { handle, ctx } = ctxOf(fileName);
  const doc = parseOpml(xml, fileName, ctx);
  return { doc, handle, sheet: doc.sheets[0] };
}

function outline(topic: Topic, depth = 0): string[] {
  const self = `${'  '.repeat(depth)}${topic.title}`;
  return [self, ...topic.children.attached.flatMap((child) => outline(child, depth + 1))];
}

function wrap(body: string, head = '<title>测试大纲</title>'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>${head}</head>
  <body>
${body}
  </body>
</opml>`;
}

// ---------------------------------------------------------------------------
// 结构
// ---------------------------------------------------------------------------

describe('结构', () => {
  it('递归的 outline 变成嵌套主题', () => {
    const { sheet } = parse(wrap(`
      <outline text="根">
        <outline text="甲">
          <outline text="甲一"/>
        </outline>
        <outline text="乙"/>
      </outline>`));
    expect(outline(sheet!.rootTopic)).toEqual(['根', '  甲', '    甲一', '  乙']);
  });

  it('文档标题取 head/title', () => {
    const { doc } = parse(wrap('<outline text="根"/>', '<title>项目计划</title>'), '任意文件名.opml');
    expect(doc.title).toBe('项目计划');
  });

  it('head 缺失时文档标题取文件名', () => {
    const xml = '<?xml version="1.0"?><opml version="2.0"><body><outline text="根"/></body></opml>';
    const { doc } = parse(xml, '季度复盘.opml');
    expect(doc.title).toBe('季度复盘');
  });

  it('head/title 是空白时也回退文件名', () => {
    const { doc } = parse(wrap('<outline text="根"/>', '<title>   </title>'), '空白标题.opml');
    expect(doc.title).toBe('空白标题');
  });
});

// ---------------------------------------------------------------------------
// 多根 outline
// ---------------------------------------------------------------------------

describe('多根 outline', () => {
  it('第一个是中心主题，其余是自由主题', () => {
    const { sheet } = parse(wrap(`
      <outline text="中心"/>
      <outline text="漂浮甲"/>
      <outline text="漂浮乙"/>`));
    expect(sheet!.rootTopic.title).toBe('中心');
    expect(sheet!.floatingTopics.map((topic) => topic.title)).toEqual(['漂浮甲', '漂浮乙']);
  });

  it('自由主题的子节点也跟着走', () => {
    const { sheet } = parse(wrap(`
      <outline text="中心"/>
      <outline text="漂浮">
        <outline text="漂浮的子"/>
      </outline>`));
    expect(outline(sheet!.floatingTopics[0]!)).toEqual(['漂浮', '  漂浮的子']);
  });

  it('单个 outline 时没有自由主题', () => {
    const { sheet } = parse(wrap('<outline text="唯一"/>'));
    expect(sheet!.floatingTopics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 属性映射
// ---------------------------------------------------------------------------

describe('属性映射', () => {
  it('text 优先于 title', () => {
    const { sheet } = parse(wrap('<outline text="正文" title="标题属性"/>'));
    expect(sheet!.rootTopic.title).toBe('正文');
  });

  it('text 缺失时回退 title', () => {
    const { sheet } = parse(wrap('<outline title="只有标题属性"/>'));
    expect(sheet!.rootTopic.title).toBe('只有标题属性');
  });

  it('两者都缺时用占位符', () => {
    const { sheet } = parse(wrap('<outline/>'));
    expect(sheet!.rootTopic.title).toBe('(未命名)');
  });

  it('_note 写入 notes.plain', () => {
    const { sheet } = parse(wrap('<outline text="根" _note="这里是备注"/>'));
    expect(sheet!.rootTopic.notes.plain).toBe('这里是备注');
  });

  it('_link 写入 href', () => {
    const { sheet } = parse(wrap('<outline text="根" _link="https://example.com/x"/>'));
    expect(sheet!.rootTopic.href).toBe('https://example.com/x');
  });

  it('_status 映射成任务标记', () => {
    const cases: Array<[string, string]> = [
      ['done', 'task-done'],
      ['started', 'task-start'],
      ['paused', 'task-pause'],
      ['canceled', 'task-cancel'],
      // 英式拼写也要认：不同导出器写法不一。
      ['cancelled', 'task-cancel'],
    ];
    for (const [status, markerId] of cases) {
      const { sheet } = parse(wrap(`<outline text="根" _status="${status}"/>`));
      expect(sheet!.rootTopic.markers.map((marker) => marker.markerId)).toEqual([markerId]);
    }
  });

  it('_status 大小写不敏感', () => {
    const { sheet } = parse(wrap('<outline text="根" _status="DONE"/>'));
    expect(sheet!.rootTopic.markers[0]?.markerId).toBe('task-done');
  });

  it('_priority 映射成优先级标记', () => {
    const { sheet } = parse(wrap('<outline text="根" _priority="3"/>'));
    expect(sheet!.rootTopic.markers).toEqual([{ groupId: 'priority', markerId: 'priority-3' }]);
  });

  it('_priority 越界或非数字时忽略', () => {
    for (const value of ['0', '10', '高', '']) {
      const { sheet } = parse(wrap(`<outline text="根" _priority="${value}"/>`));
      expect(sheet!.rootTopic.markers).toEqual([]);
    }
  });

  it('_icon 当作 markerId 直连', () => {
    const { sheet } = parse(wrap('<outline text="根" _icon="star-red"/>'));
    expect(sheet!.rootTopic.markers).toEqual([{ groupId: 'star', markerId: 'star-red' }]);
  });

  it('多个标记并存且不重复', () => {
    const { sheet } = parse(wrap('<outline text="根" _status="done" _priority="1" _icon="flag-red"/>'));
    expect(sheet!.rootTopic.markers.map((marker) => marker.markerId)).toEqual([
      'task-done',
      'priority-1',
      'flag-red',
    ]);
    // 同一个标记写两遍只留一条。
    const dup = parse(wrap('<outline text="根" _icon="flag-red" _icon="flag-red"/>'));
    expect(dup.sheet!.rootTopic.markers).toHaveLength(1);
  });

  it('认不出的 _icon 计入 marker-unknown', () => {
    const { handle } = parse(wrap('<outline text="根" _icon="sticker-smile"/>'));
    expect(handle.warnings).toContainEqual({ code: 'marker-unknown', params: { count: 1 } });
  });
});

// ---------------------------------------------------------------------------
// 空与坏
// ---------------------------------------------------------------------------

describe('空与坏', () => {
  it('不是 opml 根时返回空 sheets，交给框架判 EMPTY_DOCUMENT', () => {
    // 「空」与「坏」是两种失败，判断只该在框架里做一次。
    const { doc } = parse('<rss version="2.0"><channel/></rss>');
    expect(doc.sheets).toEqual([]);
  });

  it('没有 body 时返回空 sheets', () => {
    const { doc } = parse('<?xml version="1.0"?><opml version="2.0"><head><title>x</title></head></opml>');
    expect(doc.sheets).toEqual([]);
  });

  it('body 里没有 outline 时返回空 sheets', () => {
    const { doc } = parse(wrap(''));
    expect(doc.sheets).toEqual([]);
  });

  it('XML 结构损坏时抛错，由适配器收口成 PARSE_FAILED', () => {
    expect(() => parse('<opml><body><outline text="a"></body></opml>')).toThrow();
  });

  it('标签名大小写不敏感（OPML 2.0 是小写，但存量文件不守规矩）', () => {
    const { sheet } = parse('<OPML><BODY><OUTLINE text="根"/></BODY></OPML>');
    expect(sheet!.rootTopic.title).toBe('根');
  });
});

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

describe('端到端', () => {
  it('一份带备注与标记的典型 OPML 完整还原', () => {
    const { doc, sheet } = parse(wrap(`
      <outline text="Q3 目标">
        <outline text="提升留存" _note="看 7 日留存" _priority="1"/>
        <outline text="已完成的项" _status="done" _link="https://example.com/report"/>
      </outline>`));

    expect(doc.format).toBe('wmind');
    expect(doc.formatVersion).toBe('1.0');
    expect(doc.meta.app).toBe('opml');
    expect(outline(sheet!.rootTopic)).toEqual(['Q3 目标', '  提升留存', '  已完成的项']);

    const [first, second] = sheet!.rootTopic.children.attached;
    expect(first!.notes.plain).toBe('看 7 日留存');
    expect(first!.markers[0]?.markerId).toBe('priority-1');
    expect(second!.href).toBe('https://example.com/report');
    expect(second!.markers[0]?.markerId).toBe('task-done');
  });

  it('节点数超上限时抛 TOO_MANY_TOPICS', () => {
    const handle = createImportContext({ fileName: 'x.opml', limits: resolveLimits({ maxTopics: 2 }) });
    const body = Array.from({ length: 5 }, (_, i) => `<outline text="n${i}"/>`).join('\n');
    expect(() => parseOpml(wrap(body), 'x.opml', handle.context)).toThrowError(/TOO_MANY_TOPICS/);
  });
});
