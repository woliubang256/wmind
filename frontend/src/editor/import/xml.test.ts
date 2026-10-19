/**
 * 极小 XML 解析器的测试。
 *
 * 重点是**它拒绝了什么**：这个解析器存在的理由就是「不实现实体展开」，
 * 所以 XXE 与实体膨胀的样本必须失败或原样保留，不能悄悄展开。
 */

import { describe, expect, it } from 'vitest';
import { childOf, childrenOf, decodeXmlEntities, parseXml, pathOf, XmlParseError } from './xml';

function expectError(source: string): void {
  expect(() => parseXml(source)).toThrow(XmlParseError);
}

describe('基本结构', () => {
  it('解析元素、属性与文本', () => {
    const root = parseXml('<opml version="2.0"><body><outline text="A"/></body></opml>');
    expect(root.name).toBe('opml');
    expect(root.attrs.version).toBe('2.0');
    const outline = pathOf(root, ['body', 'outline']);
    expect(outline?.attrs.text).toBe('A');
  });

  it('单引号与双引号属性都支持', () => {
    const root = parseXml(`<a x='1' y="2"/>`);
    expect(root.attrs).toEqual({ x: '1', y: '2' });
  });

  it('自闭合标签不产生子节点', () => {
    expect(parseXml('<a><b/></a>').children).toHaveLength(1);
  });

  it('嵌套子元素与直接文本分开保存', () => {
    const root = parseXml('<a>前<b>内</b>后</a>');
    expect(root.text).toBe('前后');
    expect(root.children[0]?.text).toBe('内');
  });

  it('跳过 XML 声明、注释与处理指令', () => {
    const root = parseXml('<?xml version="1.0"?><!-- 注释 --><?php echo 1; ?><a>文</a>');
    expect(root.name).toBe('a');
    expect(root.text).toBe('文');
  });

  it('CDATA 原样保留，不做实体解码', () => {
    const root = parseXml('<a><![CDATA[a &amp; <b>]]></a>');
    expect(root.text).toBe('a &amp; <b>');
  });

  it('去掉 BOM', () => {
    expect(parseXml('\uFEFF<a/>').name).toBe('a');
  });

  it('带前缀的标签名原样保留', () => {
    const root = parseXml('<xmap:content><xmap:sheet/></xmap:content>');
    expect(root.name).toBe('xmap:content');
    expect(childrenOf(root, 'xmap:sheet')).toHaveLength(1);
  });
});

describe('实体', () => {
  it('解码五个预定义实体与数字引用', () => {
    expect(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB');
  });

  it('不认识的实体原样保留（没有 DTD 就没有定义）', () => {
    expect(decodeXmlEntities('&xxe;')).toBe('&xxe;');
  });

  it('超出 Unicode 范围的数字引用原样保留', () => {
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
  });

  it('DOCTYPE 被整段跳过，自定义实体不会被展开', () => {
    // 这是本解析器存在的核心理由：没有 DTD 就没有实体定义，
    // billion laughs 与 XXE 在结构上不可能发生。
    const source = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>',
      '<opml><body><outline text="&lol2;"/></body></opml>',
    ].join('');
    const root = parseXml(source);
    expect(pathOf(root, ['body', 'outline'])?.attrs.text).toBe('&lol2;');
  });

  it('外部实体引用不会被解析成文件内容', () => {
    const source = '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
    expect(parseXml(source).text).toBe('&x;');
  });
});

describe('错误处理', () => {
  it('标签不匹配', () => {
    expectError('<a></b>');
  });

  it('标签未闭合', () => {
    expectError('<a><b></a>');
  });

  it('多余的结束标签', () => {
    expectError('<a></a></a>');
  });

  it('多个根元素', () => {
    expectError('<a/><b/>');
  });

  it('没有根元素', () => {
    expectError('   ');
  });

  it('属性缺少引号', () => {
    expectError('<a x=1/>');
  });

  it('注释未闭合', () => {
    expectError('<a><!-- 没关</a>');
  });

  it('根元素之外有文本', () => {
    expectError('前言<a/>');
  });
});

describe('上限', () => {
  it('嵌套过深时报错而不是爆栈', () => {
    const deep = '<a>'.repeat(300) + '</a>'.repeat(300);
    expect(() => parseXml(deep, { maxDepth: 10 })).toThrow(XmlParseError);
  });

  it('元素数超限时报错', () => {
    const wide = `<r>${'<a/>'.repeat(50)}</r>`;
    expect(() => parseXml(wide, { maxNodes: 10 })).toThrow(XmlParseError);
  });
});

describe('辅助函数', () => {
  it('childOf / childrenOf / pathOf', () => {
    const root = parseXml('<r><a id="1"/><a id="2"/><b><c/></b></r>');
    expect(childOf(root, 'a')?.attrs.id).toBe('1');
    expect(childrenOf(root, 'a').map((el) => el.attrs.id)).toEqual(['1', '2']);
    expect(pathOf(root, ['b', 'c'])?.name).toBe('c');
    expect(pathOf(root, ['b', 'nope'])).toBeUndefined();
  });
});
