/**
 * 导入适配器的注册表与执行入口。
 *
 * 一次导入的固定动作序列（对应 docs/06 §2.1.2 的流程图）：
 *
 * ```
 * 尺寸闸门 → 格式探测 → 适配器解析 → 归一化闸门 → 摘要
 * ```
 *
 * 每个闸门都只做一件事，且**失败即中止**。中间任何一步抛出的异常都会被
 * 收口成 `ImportError`，界面因此永远只处理一种错误类型。
 */

import { parseDocument } from '../model/validate';
import type { WmindDocument } from '../model/types';
import { createImportContext } from './context';
import { ImportError, toImportError } from './errors';
import { resolveLimits } from './limits';
import type { ImportLimits } from './limits';
import { summarizeImport } from './summary';
import { looksLikeZip, openZip } from './zip';
import type { ZipArchive } from './zip';
import type {
  ImportAdapter,
  ImportInput,
  ImportRequest,
  ImportResult,
} from './types';

/**
 * 惰性输入。
 *
 * 50MB 的 XMind 如果一进来就 `TextDecoder.decode`，光解码就吃掉 100MB+ 的
 * 字符串，而 XMind 根本不需要文本形态。反过来 Markdown 不需要 zip。两边都
 * 只在真正用到时才付代价，且各自缓存一次。
 */
export function createImportInput(
  fileName: string,
  bytes: Uint8Array,
  limits: ImportLimits,
): ImportInput {
  let zipCache: ZipArchive | null | undefined;
  let textCache: string | null = null;

  return {
    fileName,
    size: bytes.length,
    bytes,

    zip() {
      if (zipCache !== undefined) return zipCache;
      if (!looksLikeZip(bytes)) {
        zipCache = null;
        return null;
      }
      // 不吞异常：压缩包超限 / 条目过多必须原样上报，
      // 否则会被误报成「格式不认识」，用户永远不知道该换个什么文件。
      zipCache = openZip(bytes, limits);
      return zipCache;
    },

    text() {
      if (textCache === null) {
        textCache = new TextDecoder('utf-8').decode(bytes);
      }
      return textCache;
    },
  };
}

export interface ImportRegistry {
  register(adapter: ImportAdapter): void;
  list(): readonly ImportAdapter[];
  /** 取置信度最高的适配器；都不认识返回 null。 */
  detect(input: ImportInput): ImportAdapter | null;
  run(request: ImportRequest): ImportResult;
}

export function createImportRegistry(initial: readonly ImportAdapter[] = []): ImportRegistry {
  const adapters: ImportAdapter[] = [...initial];

  const registry: ImportRegistry = {
    register(adapter) {
      const existing = adapters.findIndex((item) => item.id === adapter.id);
      // 同 id 覆盖而不是并存：并存会让「谁是权威适配器」取决于注册顺序，
      // 排查问题时极其难受。
      if (existing >= 0) adapters[existing] = adapter;
      else adapters.push(adapter);
    },

    list() {
      return adapters.slice();
    },

    detect(input) {
      let best: ImportAdapter | null = null;
      let bestScore = 0;
      for (const adapter of adapters) {
        const score = adapter.detect(input);
        // 严格大于：并列时保留先注册的，保证结果稳定可测。
        if (score > bestScore) {
          best = adapter;
          bestScore = score;
        }
      }
      return best;
    },

    run(request) {
      const limits = resolveLimits(request.limits);
      const bytes = request.bytes;

      if (bytes.length > limits.maxInputBytes) {
        throw new ImportError('FILE_TOO_LARGE', {
          size: bytes.length,
          limit: limits.maxInputBytes,
        });
      }

      const input = createImportInput(request.fileName, bytes, limits);
      const adapter = registry.detect(input);
      if (adapter === null) {
        throw new ImportError('UNKNOWN_FORMAT', {
          fileName: request.fileName,
          size: bytes.length,
        });
      }

      const handle = createImportContext({
        fileName: request.fileName,
        limits,
        ids: request.ids,
      });

      let produced: WmindDocument;
      try {
        produced = adapter.parse(input, handle.context);
      } catch (error) {
        throw toImportError(error, 'PARSE_FAILED', { fileName: request.fileName });
      }

      if (!produced || !Array.isArray(produced.sheets) || produced.sheets.length === 0) {
        // 空文档**不能**当成功：归一化层会自动补一张空画布，于是界面上
        // 出现一个「导入成功但什么都没有」的导图，用户还会把它保存下来。
        throw new ImportError('EMPTY_DOCUMENT', { fileName: request.fileName });
      }

      // 归一化闸门：适配器产出的是「我们认为的文档」，这里再过一遍权威校验，
      // 保证交给渲染层的东西一定有完整字段。字段级修补会被记成一条警告，
      // 因为那说明适配器有 bug。
      let document: WmindDocument;
      try {
        const parsed = parseDocument(produced);
        document = parsed.document;
        if (parsed.warnings.length > 0) {
          handle.context.warn('document-normalized', { count: parsed.warnings.length });
        }
      } catch (error) {
        throw toImportError(error, 'PARSE_FAILED', { fileName: request.fileName });
      }

      const summary = summarizeImport(document);

      // 兜底闸门：万一某个适配器忘了调 `ctx.topic()`，节点上限就形同虚设。
      // 这里按最终文档再数一次，宁可晚一步也不能放过。
      if (summary.topics > limits.maxTopics) {
        throw new ImportError('TOO_MANY_TOPICS', { max: limits.maxTopics });
      }

      const truncated = handle.truncatedTitles();
      if (truncated > 0) {
        handle.context.warn('title-truncated', { count: truncated });
      }

      return {
        format: adapter.id,
        document,
        warnings: handle.warnings,
        unsupported: handle.unsupported,
        summary,
        assets: handle.assets,
      };
    },
  };

  return registry;
}
