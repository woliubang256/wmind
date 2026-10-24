/**
 * Markdown 导入的测试。
 *
 * 重点不在「能不能解析」，而在三个容易做错的地方：
 *
 * 1. 层级跳跃**不补空节点**（`#` 直接接 `###`）；
 * 2. 列表层级由**相对缩进**决定，2 空格与 4 空格的文件得到同一棵树；
 * 3. 行内元素（代码 / 图片 / 链接）单次扫描，代码里的 `[a](b)` 不被当链接。
 *
 * 混合结构必须保留真实标题，不能因为列表更多就把标题丢进备注。
 */

import { describe, expect, it } from 'vitest';
import { createImportContext } from './context';
import { resolveLimits } from './limits';
import {
  detectMarkdownMode,
  parseInline,
  parseMarkdown,
  tokenizeMarkdown,
} from './markdown';
import type { Topic } from '../model/types';
import { exportMarkdown } from '../export/text';
import usedCarRequirements from './fixtures/used-car-requirements.md?raw';

function ctxOf(fileName = '笔记.md') {
  const handle = createImportContext({ fileName, limits: resolveLimits() });
  return { handle, ctx: handle.context };
}

function parse(text: string, fileName = '笔记.md') {
  const { handle, ctx } = ctxOf(fileName);
  const doc = parseMarkdown(text, fileName, ctx);
  return { doc, handle, sheet: doc.sheets[0]!, root: doc.sheets[0]!.rootTopic };
}

/** 把树压成「缩进 + 标题」的文本，方便一眼比对结构。 */
function outline(topic: Topic, depth = 0): string[] {
  const self = `${'  '.repeat(depth)}${topic.title}`;
  const rest = topic.children.attached.flatMap((child) => outline(child, depth + 1));
  return [self, ...rest];
}

// ---------------------------------------------------------------------------
// 行内元素
// ---------------------------------------------------------------------------

describe('parseInline', () => {
  it('代码片段进 labels，不进标题', () => {
    const inline = parseInline('用 `pnpm install` 装依赖');
    expect(inline.labels).toEqual(['pnpm install']);
    expect(inline.title).toBe('用  装依赖');
  });

  it('链接取第一个作为 href，其余文字保留在标题里', () => {
    const inline = parseInline('看 [文档](https://example.com/a) 和 [备份](https://example.com/b)');
    expect(inline.href).toBe('https://example.com/a');
    expect(inline.title).toBe('看 文档 和 备份');
  });

  it('图片抽成 image，标题里不留空括号', () => {
    const inline = parseInline('架构 ![示意图](https://cdn.test/a.png)');
    expect(inline.image).toEqual({ alt: '示意图', src: 'https://cdn.test/a.png' });
    expect(inline.title).toBe('架构');
  });

  it('代码里的链接语法不会被当成链接', () => {
    // 这条是单次 alternation 存在的理由：三次 replace 的写法在这里会得到
    // labels=[] 且 href='b'。
    const inline = parseInline('`[a](b)` 是字面量');
    expect(inline.labels).toEqual(['[a](b)']);
    expect(inline.href).toBe('');
  });

  it('去掉 * 与 ~~ 强调，但不动下划线', () => {
    expect(parseInline('**粗** 与 *斜* 与 ~~删~~').title).toBe('粗 与 斜 与 删');
    // `foo_bar_baz` → `foobarbaz` 比「留着下划线」糟糕得多。
    expect(parseInline('foo_bar_baz').title).toBe('foo_bar_baz');
  });

  it('链接地址里的空格标题被忽略', () => {
    const inline = parseInline('[标题](https://example.com "悬停提示")');
    expect(inline.href).toBe('https://example.com');
    expect(inline.title).toBe('标题');
  });

  it('行首的转义反斜杠被还原（导出再导入标题不多一个 \\）', () => {
    // export/text.ts 给 `#`/`-` 开头的标题加了 `\`，按 CommonMark 这里该读成 `#`。
    expect(parseInline('\\# 不是标题').title).toBe('# 不是标题');
    expect(parseInline('\\- 不是列表').title).toBe('- 不是列表');
    // 链接文字里的转义同样还原。
    expect(parseInline('[\\# 标题](https://example.com)').title).toBe('# 标题');
    // 只动行首：标题中间的 `\` 是用户自己写的，原样保留。
    expect(parseInline('路径 C:\\temp').title).toBe('路径 C:\\temp');
  });
});

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

describe('tokenizeMarkdown', () => {
  /** 尾随空行会产出一个 `blank` 令牌（下游会忽略），比对时去掉它。 */
  function solid(text: string) {
    return tokenizeMarkdown(text).filter((token) => token.kind !== 'blank');
  }

  it('围栏内的 # 不是标题', () => {
    expect(solid('```sh\n# 这是注释\necho hi\n```\n')).toEqual([
      { kind: 'code', lang: 'sh', code: '# 这是注释\necho hi' },
    ]);
  });

  it('转义标题保留为正文，不提升为节点层级', () => {
    expect(solid('\\# 文本\n\\## 仍是文本\n')).toEqual([
      { kind: 'text', text: '\\# 文本' },
      { kind: 'text', text: '\\## 仍是文本' },
    ]);
  });

  it('未闭合的围栏吃到文末', () => {
    const [token] = solid('```\ncode\n');
    expect(token).toMatchObject({ kind: 'code', lang: '' });
    // 未闭合时最后那个换行会留在正文里，对备注无害。
    expect((token as { code: string }).code.trimEnd()).toBe('code');
  });

  it('~ 围栏与 ` 围栏互不干扰', () => {
    expect(solid('~~~\n含 ``` 的代码\n~~~\n')).toEqual([
      { kind: 'code', lang: '', code: '含 ``` 的代码' },
    ]);
  });

  it('表格跳过分隔行，单元格去空白', () => {
    expect(solid('| 名称 | 数量 |\n| --- | ---: |\n| 甲 | 1 |\n')).toEqual([
      { kind: 'table', rows: [['名称', '数量'], ['甲', '1']] },
    ]);
  });

  it('任务列表抽出勾选状态', () => {
    expect(solid('- [x] 已完成\n- [ ] 未完成\n')).toEqual([
      { kind: 'item', indent: 0, text: '已完成', task: 'done' },
      { kind: 'item', indent: 0, text: '未完成', task: 'start' },
    ]);
  });

  it('制表符按 4 空格计', () => {
    expect(tokenizeMarkdown('\t- a\n')[0]).toMatchObject({ kind: 'item', indent: 4, text: 'a' });
  });
});

// ---------------------------------------------------------------------------
// 模式判定
// ---------------------------------------------------------------------------

describe('detectMarkdownMode', () => {
  it('存在真实标题 → 标题模式', () => {
    expect(detectMarkdownMode('# 甲\n## 乙\n### 丙\n')).toBe('heading');
  });

  it('只有一个标题 + 一堆列表也保留标题模式', () => {
    expect(detectMarkdownMode('# 待办\n- a\n- b\n- c\n')).toBe('heading');
  });

  it('完全没有标题 → 列表模式', () => {
    expect(detectMarkdownMode('- a\n  - b\n')).toBe('list');
  });

  it('列表数量不改变真实标题的语义', () => {
    expect(detectMarkdownMode('# a\n# b\n- 1\n- 2\n- 3\n- 4\n')).toBe('heading');
    expect(detectMarkdownMode('# a\n# b\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n')).toBe('heading');
  });

  it('围栏里的伪标题不参与模式判定', () => {
    expect(detectMarkdownMode('```md\n# a\n## b\n```\n- 实际列表\n')).toBe('list');
  });

  it('转义的标题是字面量，不盲目删除反斜杠后判定', () => {
    expect(detectMarkdownMode('\\# a\n\\## b\n- 实际列表\n')).toBe('list');
  });

  it('模式判定使用同一分词换行规则', () => {
    expect(detectMarkdownMode('# 根\r## 分支\r- 列表\r')).toBe('heading');
  });
});

// ---------------------------------------------------------------------------
// 标题模式
// ---------------------------------------------------------------------------

describe('标题模式建树', () => {
  it('用户九模块需求保留全部标题、小节和列表，不按列表占比丢层级', () => {
    const { root } = parse(usedCarRequirements, '业务需求.md');
    expect(root.title).toBe('二手车综合业务平台功能需求');
    expect(root.children.attached.map((topic) => topic.title)).toEqual([
      '一、用户与权限管理模块', '二、核心业务管理模块', '三、分销系统模块',
      '四、入驻与代理管理模块', '五、系统对接模块', '六、内容管理模块',
      '七、数据统计与分析模块', '八、门店与工厂管理模块', '九、通用功能模块',
    ]);
    let listDepth = 0;
    const expectedOutline = usedCarRequirements.split('\n').flatMap((line) => {
      const heading = /^(#{1,3}) (.+)$/.exec(line);
      if (heading) {
        listDepth = heading[1]!.length;
        return [`${'  '.repeat(listDepth - 1)}${heading[2]}`];
      }
      const item = /^( *)- (.+)$/.exec(line);
      if (!item) return [];
      return [`${'  '.repeat(listDepth + item[1]!.length / 2)}${item[2]}`];
    });
    expect(outline(root)).toEqual(expectedOutline);
    expect(outline(root)).toHaveLength(192);
    const visit = (topic: Topic): void => {
      expect(topic.notes.plain).toBe('');
      topic.children.attached.forEach(visit);
    };
    visit(root);
  });

  it('大量列表混合标题导出后重新导入仍保留完整结构', () => {
    const original = parse(usedCarRequirements).doc;
    const exported = exportMarkdown(original, original.sheets[0]!.id);
    expect(outline(parse(exported).root)).toEqual(outline(original.sheets[0]!.rootTopic));
  });

  it('单标题与长列表使用同一根节点，文档标题不受文件名影响', () => {
    const { root, doc } = parse('# 真正的标题\n' + Array.from({ length: 40 }, (_, i) => `- 项 ${i}`).join('\n'), '不同文件名.md');
    expect(root.title).toBe('真正的标题');
    expect(doc.title).toBe('真正的标题');
    expect(root.children.attached).toHaveLength(40);
    expect(root.notes.plain).toBe('');
  });

  it('长列表之间的标题跳级仍挂最近上级，列表栈不串到下个标题', () => {
    const { root } = parse('# 根\n### 深\n- a\n  - a1\n- b\n- c\n## 中\n- d\n- e\n- f\n');
    expect(outline(root)).toEqual(['根', '  深', '    a', '      a1', '    b', '    c', '  中', '    d', '    e', '    f']);
  });

  it('真实标题之间的围栏伪标题和转义标题不产生额外分支', () => {
    const { root } = parse('# 根\n## 分支\n- a\n```md\n## 伪标题\n### 也不是\n```\n\\## 字面量\n## 次分支\n- b\n');
    expect(root.children.attached.map((topic) => topic.title)).toEqual(['分支', '次分支']);
    const code = root.children.attached[0]!.children.attached[0]!.children.attached[0]!;
    expect(code.title).toBe('代码块 (md)');
    expect(code.notes.plain).toBe('## 伪标题\n### 也不是\n\\## 字面量');
  });

  it('层级跳跃不补空节点', () => {
    // `#` 之后直接 `###`：新节点挂到 `#`，不造空白的 `##`。
    const { root } = parse('# 根\n\n### 深\n\n## 中\n');
    expect(outline(root)).toEqual(['根', '  深', '  中']);
  });

  it('正常层级逐级挂接', () => {
    const { root } = parse('# A\n\n## B\n\n### C\n');
    expect(outline(root)).toEqual(['A', '  B', '    C']);
  });

  it('连续同级标题是兄弟', () => {
    const { root } = parse('# A\n\n## B\n\n## C\n');
    expect(outline(root)).toEqual(['A', '  B', '  C']);
  });

  it('同一标题下的多个列表项是兄弟，不是父子', () => {
    // 回归：listStack 弹空之后曾经拿 `current` 兜底，而 `current` 正是上一个列表项，
    // 于是同级的第二个列表项被挂到了第一个下面——整棵树凭空多一层。
    const { root } = parse('# 根\n\n## 分支\n\n- 甲\n- 乙\n- 丙\n');
    expect(outline(root)).toEqual(['根', '  分支', '    甲', '    乙', '    丙']);
  });

  it('列表项下面缩进更深的仍然是子节点', () => {
    const { root } = parse('# 根\n\n## 分支\n\n- 甲\n  - 甲一\n- 乙\n');
    expect(outline(root)).toEqual(['根', '  分支', '    甲', '      甲一', '    乙']);
  });

  it('第一个标题之前的散文成为根备注', () => {
    const { root } = parse('这段是前言\n第二行\n\n# 甲\n\n# 乙\n');
    expect(root.notes.plain).toBe('这段是前言\n第二行');
  });

  it('文档标题取中心主题，不取文件名', () => {
    const { doc } = parse('# 真正的标题\n\n## 子\n', '随便起的名字.md');
    expect(doc.title).toBe('真正的标题');
  });
});

// ---------------------------------------------------------------------------
// 列表模式
// ---------------------------------------------------------------------------

describe('列表模式建树', () => {
  it('中心主题取文件名', () => {
    const { root } = parse('- a\n- b\n', '团队清单.md');
    expect(root.title).toBe('团队清单');
    expect(outline(root)).toEqual(['团队清单', '  a', '  b']);
  });

  it('2 空格与 4 空格得到同一棵树', () => {
    const two = parse('- 根\n  - 子\n    - 孙\n').root;
    const four = parse('- 根\n    - 子\n        - 孙\n').root;
    expect(outline(two)).toEqual(outline(four));
    // 缩进按相对深度算，不是 `indent / 2`：4 空格文件不该多出一倍层数。
    expect(outline(four)).toEqual(['笔记', '  根', '    子', '      孙']);
  });

  it('缩进回退时挂到最近的上级，不按缩进量硬算层号', () => {
    // 缩进 0 → 4 → 2：第三个节点应回到第一个下面，与第二个同级。
    const { root } = parse('- a\n    - b\n  - c\n');
    expect(outline(root)).toEqual(['笔记', '  a', '    b', '    c']);
  });

  it('有序列表与无序列表混用不影响层级', () => {
    const { root } = parse('1. 第一步\n   - 细节\n2. 第二步\n', '流程.md');
    expect(outline(root)).toEqual(['流程', '  第一步', '    细节', '  第二步']);
  });

  it('任务列表转成标记', () => {
    const { root } = parse('- [x] 写完了\n- [ ] 还没写\n');
    const [done, todo] = root.children.attached;
    expect(done!.markers.map((marker) => marker.markerId)).toEqual(['task-done']);
    expect(todo!.markers.map((marker) => marker.markerId)).toEqual(['task-start']);
  });

  it('单标题加列表不凭空造出一层', () => {
    const { root } = parse('# 待办\n- a\n- b\n- c\n', '待办.md');
    expect(root.title).toBe('待办');
    expect(outline(root)).toEqual(['待办', '  a', '  b', '  c']);
  });
});

// ---------------------------------------------------------------------------
// 元素映射
// ---------------------------------------------------------------------------

describe('元素映射', () => {
  it('代码块成为子主题，正文进备注', () => {
    const { root } = parse('- 根\n\n```ts\nconst a = 1;\n```\n', '片段.md');
    const branch = root.children.attached[0]!;
    const code = branch.children.attached[0];
    expect(code?.title).toBe('代码块 (ts)');
    expect(code?.notes.plain).toBe('const a = 1;');
  });

  it('引用行追加到当前主题备注', () => {
    const { root } = parse('- 根\n\n> 第一句\n> 第二句\n', '引用.md');
    expect(root.children.attached[0]!.notes.plain).toBe('第一句\n第二句');
  });

  it('表格降级成主题并留警告', () => {
    const { root, handle } = parse('- 根\n\n| 名称 | 数量 |\n| --- | --- |\n| 甲 | 1 |\n', '表.md');
    const table = root.children.attached[0]!.children.attached.find((child) => child.title === '表格');
    expect(table).toBeDefined();
    expect(table!.children.attached.map((child) => child.title)).toEqual(['名称 | 数量', '甲 | 1']);
    expect(handle.warnings).toContainEqual({ code: 'table-degraded' });
  });

  it('独占一行的图片提升成主题，alt 当标题', () => {
    // 写成备注就彻底看不见了：备注不渲染 Markdown。
    const { root } = parse('- 根\n\n![架构图](https://cdn.test/a.png)\n', '图.md');
    const branch = root.children.attached[0]!;
    const imageTopic = branch.children.attached[0];
    expect(imageTopic?.title).toBe('架构图');
    expect(imageTopic?.image?.src).toBe('https://cdn.test/a.png');
    expect(branch.notes.plain).toBe('');
  });

  it('行内夹着图片的段落仍按段落处理，不拆节点', () => {
    const { root } = parse('- 根\n\n架构 ![图](https://cdn.test/a.png) 如下\n', '图.md');
    const branch = root.children.attached[0]!;
    expect(branch.children.attached).toEqual([]);
    expect(branch.notes.plain).toBe('架构 ![图](https://cdn.test/a.png) 如下');
  });

  it('相对路径图片计入未能还原', () => {
    const { handle } = parse('- 根\n\n![图](./images/a.png)\n', '图.md');
    expect(handle.warnings).toContainEqual({ code: 'image-skipped', params: { count: 1 } });
  });

  it('链接写进 href', () => {
    const { root } = parse('- 根\n\n- [文档](https://example.com/doc)\n', '链接.md');
    const topic = root.children.attached.find((child) => child.title === '文档');
    expect(topic?.href).toBe('https://example.com/doc');
  });
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

describe('边界', () => {
  it('空文件退化成以文件名命名的单节点', () => {
    const { doc, root } = parse('', '空文档.md');
    expect(root.title).toBe('空文档');
    expect(doc.title).toBe('空文档');
    expect(root.children.attached).toEqual([]);
  });

  it('只有空白的文件同样不抛错', () => {
    const { root } = parse('\n\n   \n\n', '空白.md');
    expect(root.title).toBe('空白');
  });

  it('CRLF 与 CR 换行都能正确分行', () => {
    expect(outline(parse('- a\r\n  - b\r\n').root)).toEqual(['笔记', '  a', '    b']);
    expect(outline(parse('- a\r  - b\r').root)).toEqual(['笔记', '  a', '    b']);
  });

  it('节点数超上限时抛 TOO_MANY_TOPICS', () => {
    const handle = createImportContext({ fileName: 'x.md', limits: resolveLimits({ maxTopics: 3 }) });
    const text = Array.from({ length: 10 }, (_, i) => `- 节点 ${i}`).join('\n');
    expect(() => parseMarkdown(text, 'x.md', handle.context)).toThrowError(/TOO_MANY_TOPICS/);
  });

  it('超长标题被截断并计数', () => {
    const handle = createImportContext({
      fileName: 'x.md',
      limits: resolveLimits({ maxTitleLength: 5 }),
    });
    const doc = parseMarkdown('- 一二三四五六七八\n', 'x.md', handle.context);
    expect(doc.sheets[0]!.rootTopic.children.attached[0]!.title).toBe('一二三四五');
    expect(handle.truncatedTitles()).toBe(1);
  });

  it('控制字符被剔除', () => {
    const { root } = parse('- 甲\u0000乙\n');
    expect(root.children.attached[0]!.title).toBe('甲乙');
  });

  it('产出的文档能通过结构校验（格式标签与版本）', () => {
    const { doc } = parse('# 甲\n\n## 乙\n');
    expect(doc.format).toBe('wmind');
    expect(doc.formatVersion).toBe('1.0');
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0]!.floatingTopics).toEqual([]);
  });
});
