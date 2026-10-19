/**
 * XMind 适配器。
 *
 * 只做「认出这是 XMind，把 zip 里的 content.json 交给 `modern.ts`」这两件事。
 * 解析逻辑刻意不放在这里：`detect` 会被每次导入调用（包括 Markdown 文件），
 * 里面不该有解析代码。
 *
 * XMind 8（`content.xml` + `styles.xml`）还没实现，见 M4.5。在那之前只认
 * `content.json`——认错格式比认不出更糟。
 */

import { ImportError } from '../errors';
import type { ImportAdapter, ImportContext, ImportInput } from '../types';
import { looksLikeZip } from '../zip';
import { parseContentJson } from './modern';

export const xmindAdapter: ImportAdapter = {
  id: 'xmind',
  extensions: ['xmind'],

  detect(input: ImportInput): number {
    // 先看 magic 再解压：普通文本文件不该为探测付一次解压的代价。
    if (!looksLikeZip(input.bytes)) return 0;
    const zip = input.zip();
    if (zip === null) return 0;
    return zip.has('content.json') ? 1 : 0;
  },

  parse(input: ImportInput, ctx: ImportContext) {
    const zip = input.zip();
    if (zip === null) throw new ImportError('NOT_A_ZIP');

    const text = zip.text('content.json');
    if (text === null) {
      // 走到这里说明 detect 与实际内容不一致（文件在探测后被改过，或 zip 里
      // 有同名但读不出的条目）。按「解析失败」上报，而不是假装成功。
      throw new ImportError('PARSE_FAILED', { fileName: input.fileName });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // content.json 不是合法 JSON：文件损坏，或不是 XMind 的 content.json。
      throw new ImportError('PARSE_FAILED', { fileName: input.fileName }, error);
    }

    return parseContentJson(parsed, input.fileName, ctx);
  },
};
