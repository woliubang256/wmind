/**
 * 备注 HTML 清洗的测试。
 *
 * 这一组全是**攻击样本**，不是功能样例：白名单清洗的价值只在于「挡得住
 * 什么」，happy path 用一条就够。
 */

import { describe, expect, it } from 'vitest';
import { sanitizeNotesHtml } from './html';

describe('保留白名单标签', () => {
  it('保留常见排版标签', () => {
    expect(sanitizeNotesHtml('<p>一段<strong>加粗</strong>文字</p>'))
      .toBe('<p>一段<strong>加粗</strong>文字</p>');
    expect(sanitizeNotesHtml('<ul><li>甲</li><li>乙</li></ul>'))
      .toBe('<ul><li>甲</li><li>乙</li></ul>');
  });

  it('自闭合的 br / hr 输出成 void 形式', () => {
    expect(sanitizeNotesHtml('第一行<br/>第二行')).toBe('第一行<br>第二行');
    expect(sanitizeNotesHtml('<hr />')).toBe('<hr>');
  });

  it('空输入返回空串', () => {
    expect(sanitizeNotesHtml('')).toBe('');
  });
});

describe('丢弃危险标签', () => {
  it('script 连同内容一起丢', () => {
    // 只丢标签会把 alert(1) 留成可见文字，那是噪音不是内容。
    expect(sanitizeNotesHtml('<p>前</p><script>alert(1)</script><p>后</p>'))
      .toBe('<p>前</p><p>后</p>');
  });

  it('style / iframe / svg 同样连内容丢', () => {
    expect(sanitizeNotesHtml('<style>p{color:red}</style>正文')).toBe('正文');
    expect(sanitizeNotesHtml('<iframe src="x"></iframe>正文')).toBe('正文');
    expect(sanitizeNotesHtml('<svg><script>x</script></svg>正文')).toBe('正文');
  });

  it('img 只丢标签，不留属性', () => {
    expect(sanitizeNotesHtml('<img src=x onerror="alert(1)">文字')).toBe('文字');
  });

  it('未闭合的危险标签吃到结尾', () => {
    expect(sanitizeNotesHtml('<p>正文</p><script>alert(1)')).toBe('<p>正文</p>');
  });
});

describe('属性白名单', () => {
  it('普通标签上的任何属性都丢掉', () => {
    // style 是 CSS 注入面，class/id 会与宿主样式打架，on* 直接是脚本。
    expect(sanitizeNotesHtml('<p style="color:red" class="x" onclick="alert(1)">文</p>'))
      .toBe('<p>文</p>');
  });

  it('a 只留 href 与 title', () => {
    expect(sanitizeNotesHtml('<a href="https://example.com" target="_blank" rel="x">链接</a>'))
      .toBe('<a href="https://example.com">链接</a>');
  });

  it('拒绝 javascript: / data: / vbscript:', () => {
    expect(sanitizeNotesHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeNotesHtml('<a href="data:text/html,<script>1</script>">x</a>')).toBe('<a>x</a>');
    expect(sanitizeNotesHtml('<a href="vbscript:msgbox">x</a>')).toBe('<a>x</a>');
  });

  it('挡住实体编码与空白混入的协议绕过', () => {
    // 这两条是经典绕过：先解码才看得出是 javascript:。
    expect(sanitizeNotesHtml('<a href="java&#x73;cript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeNotesHtml('<a href="java\tscript:alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('放行相对地址与锚点', () => {
    expect(sanitizeNotesHtml('<a href="/maps/1">x</a>')).toBe('<a href="/maps/1">x</a>');
    expect(sanitizeNotesHtml('<a href="#top">x</a>')).toBe('<a href="#top">x</a>');
    expect(sanitizeNotesHtml('<a href="mailto:a@b.c">x</a>')).toBe('<a href="mailto:a@b.c">x</a>');
  });

  it('属性值里的双引号被转义，不会逃逸出标签', () => {
    expect(sanitizeNotesHtml('<a href="https://a/?q=&quot;x&quot;">t</a>'))
      .toBe('<a href="https://a/?q=&quot;x&quot;">t</a>');
  });
});

describe('文本与结构', () => {
  it('文本原样透传，不重复转义实体', () => {
    // 再转一次会变成 &amp;amp;，用户看到字面的 &amp;。
    expect(sanitizeNotesHtml('<p>a &amp; b &lt; c</p>')).toBe('<p>a &amp; b &lt; c</p>');
  });

  it('裸 < 按文本转义', () => {
    expect(sanitizeNotesHtml('1 < 2')).toBe('1 &lt; 2');
  });

  it('丢掉注释、CDATA 标记、DOCTYPE', () => {
    expect(sanitizeNotesHtml('<!DOCTYPE html><p>文</p>')).toBe('<p>文</p>');
    expect(sanitizeNotesHtml('<!-- 注释 --><p>文</p>')).toBe('<p>文</p>');
    expect(sanitizeNotesHtml('<![CDATA[<b>文</b>]]>')).toBe('&lt;b&gt;文&lt;/b&gt;');
  });

  it('全是被丢弃内容时返回空串', () => {
    expect(sanitizeNotesHtml('<script>alert(1)</script>')).toBe('');
    expect(sanitizeNotesHtml('<!-- 只有注释 -->')).toBe('');
  });

  it('大小写混写的标签同样处理', () => {
    expect(sanitizeNotesHtml('<SCRIPT>alert(1)</SCRIPT><P>文</P>')).toBe('<p>文</p>');
  });
});
