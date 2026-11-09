/**
 * 「这个包是不是带密码」的判定。
 *
 * 加密文件在导入器眼里最糟糕的形态是**看起来正常**：条目名一个不少（`content.xml`
 * 还在，只是里面换成了密文），格式探测照样给 0.95 分，直到 XML/JSON 解析才炸。
 * 如果不单独判一次，用户看到的提示会是「解析失败」——那句话在暗示「你的文件坏了」，
 * 而事实是「文件好的，但你得先去掉密码」。两句话对应的下一步动作完全不同。
 *
 * 判定用三条**互不依赖**的证据，任何一条成立就够：
 *
 * 1. `META-INF/manifest.xml` 的根元素带 `password-hint` 属性——XMind 8 设密码时
 *    写进去的密码提醒（可以为空串）。这是最权威的一条，来自文件自己的声明。
 * 2. `manifest.json` / `metadata.json` 里出现 `password` / `encrypt` 字样的键——
 *    现代格式（2020+）的清单文件。键名大小写与嵌套层级都不固定，所以按「深度遍历
 *    所有键名」找，而不是按固定路径取。
 * 3. `content.json` / `content.xml` 的前 512 字节里出现控制字符——**文本文件不会
 *    有 C0 控制字节**（除 `\t` `\n` `\r`），密文一定有。这一条兜住前两条都不认的
 *    版本：它不看格式，只看「这堆字节到底是不是文本」。
 *
 * 第 3 条刻意**不**用「解不开就当加密」：损坏的文本文件仍然是文本，应该报
 * `PARSE_FAILED`。用「是否像二进制」而不是「是否能解析」，才能把「加密」和
 * 「损坏」这两件不同的事分开。
 */

import { ImportError } from './errors';
import type { ZipArchive } from './zip';

/** 检查前多少个字节就够。密文的随机性保证前几百字节里必然有控制字符。 */
const BINARY_PROBE_BYTES = 512;

/** 现代格式里可能带清单的两个文件。 */
const MANIFEST_JSON_ENTRIES = ['manifest.json', 'metadata.json'] as const;

/** 结构文件：加密时被替换成密文的就是它们。 */
const CONTENT_ENTRIES = ['content.json', 'content.xml'] as const;

/** 键名里出现这些词就认为是加密相关的声明。 */
const SECRET_KEY_PATTERN = /password|encrypt/i;

/**
 * 一段字节像不像二进制。
 *
 * 只认 C0 控制字符：UTF-8 多字节序列的每个字节都 ≥ 0x80，不会被误判；而
 * 制表、换行、回车是文本里唯一合法的控制字符。
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index];
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20) return true;
  }
  return false;
}

/** 深度遍历 JSON，找形如 `password` / `encrypt` 的键。 */
export function hasSecretKey(value: unknown, depth = 0): boolean {
  // 清单文件是机器写的，正常深度个位数；限深只为挡住病态输入，不是安全边界。
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasSecretKey(item, depth + 1));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => SECRET_KEY_PATTERN.test(key) || hasSecretKey(child, depth + 1),
  );
}

function declaresPasswordHint(zip: ZipArchive): boolean {
  const manifest = zip.text('META-INF/manifest.xml');
  if (manifest === null) return false;
  // 只认 `password-hint="…"` 这种**属性赋值**，不认正文里提到这几个字——
  // 加密文件的正文读不出来，能读出来的只有清单。
  return /\bpassword-hint\s*=/i.test(manifest);
}

function manifestMentionsSecrets(zip: ZipArchive): boolean {
  for (const name of MANIFEST_JSON_ENTRIES) {
    const text = zip.text(name);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 清单自己都坏了，这条证据作废；不阻断，交给后面的内容判定。
      continue;
    }
    if (hasSecretKey(parsed)) return true;
  }
  return false;
}

function contentLooksBinary(zip: ZipArchive): boolean {
  for (const name of CONTENT_ENTRIES) {
    const bytes = zip.bytes(name);
    if (bytes === null) continue;
    if (looksBinary(bytes)) return true;
  }
  return false;
}

/** 带密码就抛 `ENCRYPTED`，否则静默返回。 */
export function assertNotEncrypted(zip: ZipArchive): void {
  if (declaresPasswordHint(zip) || manifestMentionsSecrets(zip) || contentLooksBinary(zip)) {
    throw new ImportError('ENCRYPTED');
  }
}
