/**
 * XMind 8（content.xml + styles.xml）解析的测试。
 *
 * 直接喂 XML 字符串而不是造压缩包：zip 与格式探测在 `index.test.ts` 里单独
 * 验，这里关心的是**映射是否正确**。混在一起会让失败原因变模糊。
 *
 * 夹具按 `docs/06 §2.1.4` 描述的结构写（命名空间、`<children><topics
 * type>`、`style-id` 引用、`<notes><plain|html>`）。**注意**：它们是按规范
 * 重建的，不是真实 XMind 8 导出文件——M4.11 验收前需要用真实样本替换，
 * 这件事记在对应的 agent note 里。
 */

import { describe, expect, it } from 'vitest';
import { createImportContext } from '../context';
import { resolveLimits } from '../limits';
import { parseContentXml, parseLegacyStyles } from './legacy';

const CONTENT = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xhtml="http://www.w3.org/1999/xhtml" version="2.0" timestamp="1600000000000">
  <sheet id="sheet-1" theme="theme-1">
    <topic id="root" structure-class="org.xmind.ui.logic.right">
      <title>产品规划</title>
      <children>
        <topics type="attached">
          <topic id="a" style-id="style-a">
            <title>调研</title>
            <notes>
              <plain>先做访谈</plain>
              <html><xhtml:div><xhtml:p>先做<xhtml:strong>访谈</xhtml:strong></xhtml:p></xhtml:div></html>
            </notes>
            <marker-refs>
              <marker-ref marker-id="priority-1"/>
              <marker-ref marker-id="task-done"/>
              <marker-ref marker-id="weird-marker"/>
            </marker-refs>
            <labels><label>P0</label><label>用户</label></labels>
            <children>
              <topics type="attached"><topic id="a1"><title>访谈提纲</title></topic></topics>
            </children>
          </topic>
          <topic id="b" branch="folded" href="https://example.com">
            <title>设计</title>
            <children>
              <topics type="attached"><topic id="b1"><title>线框</title></topic></topics>
            </children>
          </topic>
        </topics>
        <topics type="detached">
          <topic id="f1"><title>自由主题</title></topic>
        </topics>
      </children>
    </topic>
    <relationships>
      <relationship id="r1" end1="a" end2="b"><title>依赖</title></relationship>
    </relationships>
    <boundaries>
      <boundary id="bd1" range="(a,b)"><title>一期</title></boundary>
    </boundaries>
    <summaries>
      <summary id="s1" range="(a1)" topic-id="a"><topic id="st1"><title>两周内</title></topic></summary>
    </summaries>
  </sheet>
</xmap-content>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-styles xmlns="urn:xmind:xmap:xmlns:style:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" xmlns:svg="http://www.w3.org/2000/svg" version="2.0">
  <styles>
    <style id="style-a" type="topic">
      <topic-properties shape-class="org.xmind.ui.roundedRect" line-class="org.xmind.branchConnection.elbow" line-color="#336699" line-width="2" fill-color="#FFEECC"/>
      <text-properties fo:font-family="微软雅黑" fo:font-size="14pt" fo:font-weight="bold" text-color="#222222"/>
    </style>
  </styles>
  <master-styles>
    <style id="theme-1" type="theme">
      <map-properties svg:fill="#FAFAFA"/>
    </style>
  </master-styles>
</xmap-styles>`;

function ctxOf() {
  return createImportContext({ fileName: '产品规划.xmind', limits: resolveLimits() });
}

function parse(content = CONTENT, styles: string | null = STYLES, resources?: Map<string, Uint8Array>) {
  const handle = ctxOf();
  const parsed = parseLegacyStyles(styles, handle.context);
  const document = parseContentXml(content, parsed, '产品规划.xmind', handle.context, resources);
  return { handle, document, styles: parsed };
}

/** 取根节点的第 n 个一级分支。 */
function branch(document: ReturnType<typeof parse>['document'], index: number) {
  return document.sheets[0]?.rootTopic.children.attached[index];
}

describe('结构', () => {
  it('读出一张画布与整棵树', () => {
    const { document } = parse();
    expect(document.sheets).toHaveLength(1);
    expect(document.sheets[0]?.rootTopic.title).toBe('产品规划');
    expect(document.sheets[0]?.rootTopic.children.attached.map((t) => t.title)).toEqual(['调研', '设计']);
    expect(branch(document, 0)?.children.attached[0]?.title).toBe('访谈提纲');
  });

  it('文档标题取文件名（XMind 不存文档级标题）', () => {
    const { document } = parse();
    expect(document.title).toBe('产品规划');
    expect(document.meta.app).toBe('xmind');
  });

  it('structure-class 映射到本项目结构', () => {
    const { document } = parse();
    expect(document.sheets[0]?.structure).toBe('logic-right');
  });

  it('不认识的结构回退为思维导图并留警告', () => {
    const { handle, document } = parse(
      CONTENT.replace('org.xmind.ui.logic.right', 'org.xmind.ui.radial'),
    );
    expect(document.sheets[0]?.structure).toBe('mindmap');
    expect(handle.warnings.some((w) => w.code === 'structure-fallback')).toBe(true);
  });

  it('detached 子节点提升为自由主题', () => {
    const { document } = parse();
    expect(document.sheets[0]?.floatingTopics.map((t) => t.title)).toEqual(['自由主题']);
    expect(document.sheets[0]?.rootTopic.children.detached).toEqual([]);
  });

  it('没有 sheet 时返回空数组，交给框架判 EMPTY_DOCUMENT', () => {
    const { document } = parse('<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"/>');
    expect(document.sheets).toEqual([]);
  });

  it('XML 结构错误抛出去，由适配器转 PARSE_FAILED', () => {
    expect(() => parse('<xmap-content><sheet></xmap-content>')).toThrow();
  });
});

describe('节点属性', () => {
  it('备注的 plain 与 html 都读出来，且 html 去掉了命名空间前缀', () => {
    const topic = branch(parse().document, 0);
    expect(topic?.notes.plain).toBe('先做访谈');
    expect(topic?.notes.html).toContain('<div>');
    expect(topic?.notes.html).toContain('<strong>访谈</strong>');
    expect(topic?.notes.html).not.toContain('xhtml:');
  });

  it('标签与标记', () => {
    const { handle, document } = parse();
    const topic = branch(document, 0);
    expect(topic?.labels).toEqual(['P0', '用户']);
    expect(topic?.markers).toEqual([
      { groupId: 'priority', markerId: 'priority-1' },
      { groupId: 'task', markerId: 'task-done' },
    ]);
    // 不认识的标记 id 计入警告，而不是写进文档
    expect(handle.warnings).toContainEqual({ code: 'marker-unknown', params: { count: 1 } });
  });

  it('branch="folded" 映射为折叠，href 原样保留', () => {
    const topic = branch(parse().document, 1);
    expect(topic?.collapsed).toBe(true);
    expect(topic?.href).toBe('https://example.com');
  });

  it('实体解码与空白', () => {
    const { document } = parse(CONTENT.replace('<title>产品规划</title>', '<title>A &amp; B</title>'));
    expect(document.sheets[0]?.rootTopic.title).toBe('A & B');
  });

  it('id 冲突时后来者换新 id，引用仍指向先出现的那个', () => {
    const duplicated = CONTENT.replace('id="a1"', 'id="a"');
    const { document } = parse(duplicated);
    const root = document.sheets[0]?.rootTopic;
    const first = root?.children.attached[0];
    expect(first?.id).toBe('a');
    // 子节点的 id 被换掉，但外框/概要的引用还在指向 'a'
    expect(first?.children.attached[0]?.id).not.toBe('a');
    expect(document.sheets[0]?.boundaries[0]?.range).toEqual(['a', 'b']);
  });
});

describe('样式', () => {
  it('style-id 解析到形状、填充、字体、文字颜色', () => {
    const topic = branch(parse().document, 0);
    expect(topic?.style?.shape).toBe('rounded-rect');
    expect(topic?.style?.fill).toBe('#FFEECC');
    expect(topic?.style?.borderColor).toBe('#336699');
    expect(topic?.style?.borderWidth).toBe(2);
    expect(topic?.style?.fontFamily).toBe('sans');
    // 14pt → 19px（1pt = 4/3 px，四舍五入）
    expect(topic?.style?.fontSize).toBe(19);
    expect(topic?.style?.fontWeight).toBe(700);
    expect(topic?.style?.textColor).toBe('#222222');
  });

  it('line-class 映射为分支线型', () => {
    const topic = branch(parse().document, 0);
    expect(topic?.style?.lineStyle).toBe('elbow');
  });

  it('认识的字体名静默归一，不打扰用户', () => {
    const { handle } = parse();
    expect(handle.warnings.some((w) => w.code === 'font-normalized')).toBe(false);
  });

  it('不认识的字体名归一后留警告，用户能解释「为什么字变了」', () => {
    const { handle } = parse(CONTENT, STYLES.replace('微软雅黑', 'Comic Sans MS'));
    expect(handle.warnings.some((w) => w.code === 'font-normalized')).toBe(true);
  });

  it('主题的背景色还原到文档主题上', () => {
    const { document } = parse();
    expect(document.theme.palette.backgroundColor).toBe('#FAFAFA');
  });

  it('主题 id 在 styles.xml 里查不到时回退并留警告', () => {
    const { handle, document } = parse(CONTENT, STYLES.replace('theme-1', 'theme-x'));
    expect(handle.warnings.some((w) => w.code === 'palette-fallback')).toBe(true);
    expect(document.theme.palette.backgroundColor).not.toBe('#FAFAFA');
  });

  it('styles.xml 坏掉时降级为「只导入内容」，不阻断', () => {
    const { handle, document, styles } = parse(CONTENT, '<xmap-styles><style></xmap-styles>');
    expect(styles.failed).toBe(true);
    expect(handle.warnings.some((w) => w.code === 'styles-ignored')).toBe(true);
    expect(document.sheets[0]?.rootTopic.children.attached).toHaveLength(2);
    expect(document.sheets[0]?.rootTopic.children.attached[0]?.style).toEqual({});
  });

  it('styles.xml 缺失时不报错也不告警', () => {
    const { handle } = parse(CONTENT, null);
    expect(handle.warnings.some((w) => w.code === 'styles-ignored')).toBe(false);
  });
});

describe('联系 / 外框 / 概要', () => {
  it('联系的两端重映射到文档内 id', () => {
    const { document } = parse();
    const [relationship] = document.sheets[0]?.relationships ?? [];
    expect(relationship?.title).toBe('依赖');
    const ids = [
      document.sheets[0]?.rootTopic.children.attached[0]?.id,
      document.sheets[0]?.rootTopic.children.attached[1]?.id,
    ];
    expect([relationship?.end1Id, relationship?.end2Id]).toEqual(ids);
  });

  it('外框的 range 重映射', () => {
    const { document } = parse();
    const [boundary] = document.sheets[0]?.boundaries ?? [];
    expect(boundary?.title).toBe('一期');
    expect(boundary?.range).toHaveLength(2);
  });

  it('概要的标题来自它自带的 topic', () => {
    const { document } = parse();
    const [summary] = document.sheets[0]?.summaries ?? [];
    expect(summary?.title).toBe('两周内');
    expect(summary?.topicId).toBe(document.sheets[0]?.rootTopic.children.attached[0]?.id);
    expect(summary?.range).toHaveLength(1);
  });

  it('端点不存在的联系被丢掉（画不出零长度线）', () => {
    const { document } = parse(CONTENT.replace('end2="b"', 'end2="ghost"'));
    expect(document.sheets[0]?.relationships).toEqual([]);
  });
});

describe('图片', () => {
  const withImage = CONTENT.replace(
    '<xhtml:div><xhtml:p>先做<xhtml:strong>访谈</xhtml:strong></xhtml:p></xhtml:div>',
    '<xhtml:div><xhtml:p><xhtml:img xhtml:src="xap:resources/pic.png" width="160" height="120"/></xhtml:p></xhtml:div>',
  );

  it('备注里的图片提升为节点图片，并登记为待上传资源', () => {
    const resources = new Map([['resources/pic.png', new Uint8Array([1, 2, 3])]]);
    const { handle, document } = parse(withImage, STYLES, resources);
    const topic = branch(document, 0);
    expect(topic?.image).toEqual({ src: 'xap:resources/pic.png', width: 160, height: 120 });
    expect(handle.assets).toHaveLength(1);
    expect(handle.assets[0]?.mime).toBe('image/png');
    expect(handle.assets[0]?.fileName).toBe('resources/pic.png');
  });

  it('资源不在包里时计入 image-skipped，不留死链', () => {
    const { handle, document } = parse(withImage, STYLES, new Map());
    expect(branch(document, 0)?.image).toBeNull();
    expect(handle.warnings).toContainEqual({ code: 'image-skipped', params: { count: 1 } });
  });

  it('多张图片只提升第一张，其余计入未能还原', () => {
    const two = withImage.replace(
      '</xhtml:p></xhtml:div>',
      '</xhtml:p><xhtml:p><xhtml:img xhtml:src="xap:resources/pic.png"/><xhtml:img xhtml:src="xap:resources/other.png"/></xhtml:p></xhtml:div>',
    );
    const resources = new Map([
      ['resources/pic.png', new Uint8Array([1])],
      ['resources/other.png', new Uint8Array([2])],
    ]);
    const { handle } = parse(two, STYLES, resources);
    expect(handle.assets).toHaveLength(1);
    expect(handle.warnings).toContainEqual({ code: 'image-skipped', params: { count: 2 } });
  });
});

describe('元素名与属性名的宽容度', () => {
  it('元素名大小写不敏感', () => {
    const upper = CONTENT.replace('<topic id="a1">', '<TOPIC id="a1">').replace('</topic>', '</TOPIC>');
    const { document } = parse(upper);
    expect(document.sheets[0]?.rootTopic.title).toBe('产品规划');
  });

  it('属性名认 styleId 这种驼峰写法', () => {
    const { document } = parse(CONTENT.replace('style-id="style-a"', 'styleId="style-a"'));
    expect(branch(document, 0)?.style?.fill).toBe('#FFEECC');
  });

  it('svg:fill 与 fill-color 两种拼法都认', () => {
    const { document } = parse(CONTENT, STYLES.replace('fill-color="#FFEECC"', 'svg:fill="#FFEECC"'));
    expect(branch(document, 0)?.style?.fill).toBe('#FFEECC');
  });
});

describe('上下文约束', () => {
  it('节点数超过上限时抛 TOO_MANY_TOPICS', () => {
    const handle = createImportContext({ fileName: 'x.xmind', limits: resolveLimits({ maxTopics: 2 }) });
    expect(() =>
      parseContentXml(CONTENT, parseLegacyStyles(STYLES, handle.context), 'x.xmind', handle.context),
    ).toThrowError(/TOO_MANY_TOPICS/);
  });

  it('控制字符被清掉、超长标题被截断', () => {
    const long = 'A'.repeat(30);
    const handle = createImportContext({
      fileName: 'x.xmind',
      limits: resolveLimits({ maxTitleLength: 10 }),
    });
    const document = parseContentXml(
      CONTENT.replace('<title>设计</title>', `<title>${long}</title>`),
      parseLegacyStyles(STYLES, handle.context),
      'x.xmind',
      handle.context,
    );
    expect(document.sheets[0]?.rootTopic.children.attached[1]?.title).toBe('A'.repeat(10));
  });
});
