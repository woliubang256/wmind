/**
 * 纯文本格式的适配器：Markdown 与 OPML。
 *
 * 两个格式的解析器互不相干，但**探测**逻辑共享同一件事：先排除 zip，再看开头
 * 一小段。放在一起是因为探测的优先级必须在一个文件里看得见——OPML 的分数
 * 高于 Markdown，否则一个 `<opml>` 文件会被 Markdown 抢走（它的正文里也可能
 * 有 `#`）。
 */

import { ImportError } from './errors';
import { parseMarkdown } from './markdown';
import { parseOpml } from './opml';
import type { ImportAdapter, ImportInput } from './types';
import { looksLikeZip } from './zip';
import { XmlParseError } from './xml';

/** 只看开头这么多字节：探测不该为 50MB 的文件付全量解码的代价。 */
const HEAD_BYTES = 8192;

function headText(input: ImportInput): string {
  // 截断处可能切在多字节字符中间，TextDecoder 会给出替换字符——对探测无影响。
  return new TextDecoder('utf-8').decode(input.bytes.subarray(0, HEAD_BYTES));
}

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  return (match?.[1] ?? '').toLowerCase();
}

export const markdownAdapter: ImportAdapter = {
  id: 'markdown',
  extensions: ['md', 'markdown'],

  detect(input: ImportInput): number {
    if (looksLikeZip(input.bytes)) return 0;
    const head = headText(input);
    // XML / HTML 不是 Markdown：宁可判「不认识」，也不要把它拆成一堆空节点。
    if (/^\s*<\?xml|<opml[\s>]|<html[\s>]/i.test(head)) return 0;

    // 扩展名是最强的信号：`notes.md` 里哪怕只有一行散文，它也是 Markdown。
    const byExtension = extensionOf(input.fileName) === 'md' || extensionOf(input.fileName) === 'markdown'
      ? 0.75
      : 0;

    let byContent = 0;
    if (/^#{1,6}\s+\S/m.test(head)) byContent += 0.4;
    if (/^[ \t]*[-*+]\s+\S/m.test(head)) byContent += 0.3;
    if (/^[ \t]*\d+[.)]\s+\S/m.test(head)) byContent += 0.2;
    if (/\[[^\]\n]+\]\([^)\s]+\)/.test(head)) byContent += 0.1;

    // 内容推断最多 0.8：给「真的是 OPML」留出超过它的空间。
    return Math.max(byExtension, Math.min(byContent, 0.8));
  },

  parse(input: ImportInput, ctx) {
    return parseMarkdown(input.text(), input.fileName, ctx);
  },
};

export const opmlAdapter: ImportAdapter = {
  id: 'opml',
  extensions: ['opml', 'xml'],

  detect(input: ImportInput): number {
    if (looksLikeZip(input.bytes)) return 0;
    const head = headText(input);
    if (/<opml[\s>]/i.test(head)) return 0.95;
    const ext = extensionOf(input.fileName);
    return ext === 'opml' || ext === 'xml' ? 0.7 : 0;
  },

  parse(input: ImportInput, ctx) {
    try {
      return parseOpml(input.text(), input.fileName, ctx);
    } catch (error) {
      // XML 结构错误统一收口成 PARSE_FAILED；其它异常原样抛出，由 run() 兜底。
      if (error instanceof XmlParseError) {
        throw new ImportError('PARSE_FAILED', { fileName: input.fileName }, error);
      }
      throw error;
    }
  },
};
