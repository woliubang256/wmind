/**
 * zip 读取的安全外壳。
 *
 * 直接用 `unzipSync` 是危险的：它会把整个压缩包一次性摊平到内存里，而
 * 「压缩包 1KB、解开 1GB」正是 zip 炸弹的形态。这一层的职责就三件事：
 *
 * 1. **只认固定文件名**。结构文件走精确白名单，图片走 `resources/` 前缀 +
 *    名字合法性检查。绝不按条目名去拼路径，所以「路径穿越」在结构上不可能
 *    发生——不是靠过滤 `..` 拦下来的，而是根本没把条目名当路径用过。
 * 2. **解压前就记账**。fflate 的 `filter` 在解压每个条目之前调用，能拿到
 *    声明的大小；累计超限时**抛错**（fflate 会让异常透出来），此时炸弹条目
 *    还没被分配内存。
 * 3. **只解压白名单**。`content.json` 之外的东西（缩略图、附件、贴纸资源）
 *    第一次扫描根本不碰，第二次只在适配器明确要图片时才按需解压。
 *
 * 记账用的是一个**跨多次扫描共享**的预算：结构文件一次、`resources/` 一次，
 * 两次加起来仍然受 200MB 约束。如果各算各的，实际峰值就会翻倍。
 */

import { unzipSync } from 'fflate';
import { ImportError, toImportError } from './errors';
import type { ImportLimits } from './limits';

/**
 * 结构文件白名单：精确匹配，不接受任何前缀/后缀变体。
 *
 * `META-INF/manifest.xml` 带斜杠看着像「目录」，但它仍然是**字面量**，
 * 不做任何路径拼接，所以不构成穿越面。
 */
const STRUCTURAL_ENTRIES = new Set([
  'content.json',
  'metadata.json',
  'manifest.json',
  'content.xml',
  'styles.xml',
  'meta.xml',
  'META-INF/manifest.xml',
]);

const RESOURCE_PREFIX = 'resources/';
const MAX_ENTRY_NAME_LENGTH = 512;

/** zip 的四种签名：普通条目、空包、分卷、数据描述符续段。 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const third = bytes[2];
  const fourth = bytes[3];
  return (third === 0x03 && fourth === 0x04)
    || (third === 0x05 && fourth === 0x06)
    || (third === 0x07 && fourth === 0x08);
}

/**
 * 条目名是否「安全」。
 *
 * 即使当前代码只把条目名当 Map 的键、不落盘，也必须挡：将来做「导入时把
 * 资源写到 IndexedDB / 本地目录」时，这些名字会被当成路径用，届时忘了校验
 * 就是穿越漏洞。在这里挡掉，成本是零。
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_ENTRY_NAME_LENGTH) return false;
  if (name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  // 空段（`a//b`）、`.`、`..` 一律拒绝。
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function isResourceEntryName(name: string): boolean {
  return name.length > RESOURCE_PREFIX.length
    && name.startsWith(RESOURCE_PREFIX)
    && isSafeEntryName(name);
}

export interface ZipArchive {
  /** 白名单结构文件是否存在。用于格式探测，不触发解压。 */
  has(name: string): boolean;
  /** 按固定文件名读文本。不存在返回 null。 */
  text(name: string): string | null;
  /** 按固定文件名读原始字节。不存在返回 null。 */
  bytes(name: string): Uint8Array | null;
  /** 中央目录里的全部条目名（只用于诊断与警告，**不要**拿去读内容）。 */
  entries(): readonly string[];
  /** 按需解压 `resources/` 下的图片。重复调用复用结果。 */
  resources(): ReadonlyMap<string, Uint8Array>;
}

interface ByteBudget {
  used: number;
  readonly limit: number;
}

/**
 * 打开一个 zip。
 *
 * 只做「读」不做「猜」：如果这不是 zip、或者结构文件全都不在，返回的
 * archive 里就是空的，由上层适配器决定报什么错——注册表在探测阶段也会
 * 用空 archive 来判断「是不是 XMind」。
 */
export function openZip(bytes: Uint8Array, limits: ImportLimits): ZipArchive {
  if (bytes.length > limits.maxInputBytes) {
    throw new ImportError('FILE_TOO_LARGE', { size: bytes.length, limit: limits.maxInputBytes });
  }
  if (!looksLikeZip(bytes)) {
    throw new ImportError('NOT_A_ZIP');
  }

  const budget: ByteBudget = { used: 0, limit: limits.maxTotalUncompressedBytes };
  const names: string[] = [];

  /**
   * 跑一次带守卫的解压。
   *
   * `filter` 里做三件事：记账、查条目数、按白名单决定是否解压。记账放在
   * **accept 之前**——被拒绝的条目不会解压，所以只对接受的条目计费；
   * 否则两次扫描会把同一批条目算两遍，合法文件也会被误杀。
   */
  function pass(accept: (name: string) => boolean, enumerate: boolean): Record<string, Uint8Array> {
    return unzipSync(bytes, {
      filter: (file) => {
        const name = file.name;

        if (enumerate) {
          if (names.length >= limits.maxEntries) {
            throw new ImportError('TOO_MANY_ENTRIES', { limit: limits.maxEntries });
          }
          names.push(name);
        }

        if (!accept(name)) return false;

        // 只支持 stored / deflate。LZMA 之类 fflate 会抛一句难以理解的
        // 内部错误，这里提前换成可翻译的 code。
        if (file.compression !== 0 && file.compression !== 8) {
          throw new ImportError('PARSE_FAILED', { name, method: file.compression });
        }
        if (file.originalSize > limits.maxEntryBytes) {
          throw new ImportError('ENTRY_TOO_LARGE', {
            name,
            size: file.originalSize,
            limit: limits.maxEntryBytes,
          });
        }
        budget.used += file.originalSize;
        if (budget.used > budget.limit) {
          throw new ImportError('UNZIP_LIMIT_EXCEEDED', {
            name,
            limit: budget.limit,
          });
        }
        return true;
      },
    });
  }

  let structural: Record<string, Uint8Array>;
  try {
    structural = pass((name) => STRUCTURAL_ENTRIES.has(name), true);
  } catch (error) {
    // 结构扫描阶段的任何异常都意味着「这不是一个我们能读的 zip」。
    // ImportError 原样透传（超限、条目过大都要保留精确 code）。
    throw toImportError(error, 'NOT_A_ZIP');
  }

  let resourceCache: ReadonlyMap<string, Uint8Array> | null = null;

  const decoder = new TextDecoder('utf-8');

  // 用局部函数而不是 `this.bytes(...)`：适配器很可能把方法解构出来用
  // （`const { text } = zip`），那样 `this` 就丢了，报错点会离真正原因很远。
  function readBytes(name: string): Uint8Array | null {
    if (!STRUCTURAL_ENTRIES.has(name)) return null;
    return structural[name] ?? null;
  }

  return {
    has(name) {
      return Object.prototype.hasOwnProperty.call(structural, name);
    },
    bytes: readBytes,
    text(name) {
      const data = readBytes(name);
      if (data === null) return null;
      return decoder.decode(data);
    },
    entries() {
      return names.slice();
    },
    resources() {
      if (resourceCache !== null) return resourceCache;
      // 失败**不吞**：调用方要能区分「没有图片」和「图片读不出来」，
      // 前者静默，后者必须出一条 warning。吞掉就永远分不清。
      const extracted = pass(isResourceEntryName, false);
      resourceCache = new Map(Object.entries(extracted));
      return resourceCache;
    },
  };
}
