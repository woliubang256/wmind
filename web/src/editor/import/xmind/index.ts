/**
 * XMind 适配器。
 *
 * 只做三件事：认出这是 XMind、把 zip 里的结构文件交给对应的解析器、把
 * 解析异常翻译成可翻译的 code。解析逻辑刻意不放在这里：`detect` 会被每次
 * 导入调用（包括 Markdown 文件），里面不该有解析代码。
 *
 * 两种格式靠结构文件区分：
 *
 * - `content.json` → 现代格式（XMind 2020+），见 `modern.ts`
 * - `content.xml`  → 经典格式（XMind 8），见 `legacy.ts`
 *
 * 两个都在时现代格式优先（分数 1 对 0.95）：XMind 2020 之后的包里不会再带
 * `content.xml`，真同时出现说明是「另存为旧版」留下的残留，按新的读更接近
 * 用户在 XMind 里看到的样子。
 */

import { assertNotEncrypted } from '../encryption';
import { ImportError, toImportError } from '../errors';
import type { ImportAdapter, ImportContext, ImportInput } from '../types';
import { looksLikeZip } from '../zip';
import { parseContentXml, parseLegacyStyles } from './legacy';
import { parseContentJson } from './modern';
import { isLegacyWmindMetadata, restoreLegacyWmindStyles } from './wmind-compat';

export const xmindAdapter: ImportAdapter = {
  id: 'xmind',
  extensions: ['xmind'],

  detect(input: ImportInput): number {
    // 先看 magic 再解压：普通文本文件不该为探测付一次解压的代价。
    if (!looksLikeZip(input.bytes)) return 0;
    const zip = input.zip();
    if (zip === null) return 0;
    if (zip.has('content.json')) return 1;
    if (zip.has('content.xml')) return 0.95;
    return 0;
  },

  parse(input: ImportInput, ctx: ImportContext) {
    const zip = input.zip();
    if (zip === null) throw new ImportError('NOT_A_ZIP');

    // 加密判定必须早于任何内容解析：加密包的条目名齐全，探测分数照给，
    // 不先判一次的话用户只会拿到「解析失败」，而真正的下一步是「去密码」。
    assertNotEncrypted(zip);

    if (zip.has('content.json')) return parseModern(input, ctx);

    const contentXml = zip.text('content.xml');
    if (contentXml === null) {
      // 走到这里说明 detect 与实际内容不一致（文件在探测后被改过，或 zip 里
      // 有同名但读不出的条目）。按「解析失败」上报，而不是假装成功。
      throw new ImportError('PARSE_FAILED', { fileName: input.fileName });
    }

    // 样式读不出来不阻断导入（docs/06 §2.1.4）：`parseLegacyStyles` 内部
    // 已经降级并留了 `styles-ignored`。
    const styles = parseLegacyStyles(zip.text('styles.xml'), ctx);

    try {
      // 图片只在真的存在资源时才解压：没有图片的文件不该多付一遍解压开销。
      return parseContentXml(contentXml, styles, input.fileName, ctx, zip.resources());
    } catch (error) {
      throw toImportError(error, 'PARSE_FAILED', { fileName: input.fileName });
    }
  },
};

function parseModern(input: ImportInput, ctx: ImportContext) {
  const zip = input.zip();
  if (zip === null) throw new ImportError('NOT_A_ZIP');

  const text = zip.text('content.json');
  if (text === null) throw new ImportError('PARSE_FAILED', { fileName: input.fileName });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // content.json 不是合法 JSON：文件损坏，或不是 XMind 的 content.json。
    throw new ImportError('PARSE_FAILED', { fileName: input.fileName }, error);
  }

  if (isLegacyWmindMetadata(zip.text('metadata.json'))) restoreLegacyWmindStyles(parsed);
  return parseContentJson(parsed, input.fileName, ctx, zip.resources());
}
