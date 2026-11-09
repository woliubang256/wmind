/**
 * 适配器运行时的受控环境。
 *
 * 把「计数 / 留痕 / 截断 / 生成 ID」收在一个对象里，而不是让每个适配器自己
 * 维护：节点上限只要有一个适配器忘了加，炸弹就能从那个口子进来。适配器拿不到
 * 全局状态，也就没法绕过。
 */

import { newBoundaryId, newDocumentId, newRelationshipId, newSheetId, newSummaryId, newTopicId } from '../model/ids';
import { ImportError } from './errors';
import type { ImportLimits } from './limits';
import type {
  ImportAsset,
  ImportContext,
  ImportIdFactory,
  ImportWarning,
  UnsupportedSummary,
} from './types';

/**
 * 控制字符。保留 `\n`（XMind 允许标题换行）与 `\t`，其余删掉。
 *
 * 不删的后果：`\u0000` 进 DOM 会被静默截断，进 SVG `text` 会让整段文字消失，
 * 而界面上看不出任何报错——比直接报错难查得多。
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const defaultIds: ImportIdFactory = {
  document: newDocumentId,
  sheet: newSheetId,
  topic: newTopicId,
  relationship: newRelationshipId,
  boundary: newBoundaryId,
  summary: newSummaryId,
};

export interface ImportContextHandle {
  context: ImportContext;
  warnings: ImportWarning[];
  unsupported: UnsupportedSummary;
  /** 待上传的图片，按 `ref` 去重（同一张图挂多个节点只传一次）。 */
  assets: ImportAsset[];
  topicCount(): number;
  /** 被截断的标题数量。由调用方在结束时汇总成一条警告，避免刷屏。 */
  truncatedTitles(): number;
}

export interface CreateImportContextOptions {
  fileName: string;
  limits: ImportLimits;
  ids?: ImportIdFactory;
}

export function createImportContext(options: CreateImportContextOptions): ImportContextHandle {
  const { fileName, limits } = options;
  const ids = options.ids ?? defaultIds;

  const warnings: ImportWarning[] = [];
  const seenWarnings = new Set<string>();
  const unsupported: UnsupportedSummary = {};
  const assets: ImportAsset[] = [];
  const seenAssets = new Set<string>();
  let topics = 0;
  let truncated = 0;

  const context: ImportContext = {
    fileName,
    ids,

    warn(code, params) {
      // 同 code + 同参数只留一条：一个 2 万节点的文件里「楷体→serif」可能
      // 触发几千次，全列出来等于把对话框变成日志窗口。计数类的信息应该
      // 走 params（如 `{ count }`）而不是重复条目。
      const key = params ? `${code}|${JSON.stringify(params)}` : code;
      if (seenWarnings.has(key)) return;
      seenWarnings.add(key);
      warnings.push(params ? { code, params } : { code });
    },

    unsupported(feature, count = 1) {
      if (count <= 0) return;
      unsupported[feature] = (unsupported[feature] ?? 0) + count;
    },

    asset(asset) {
      // 同一张图可能被多个节点引用（XMind 复制粘贴会共用资源条目）。
      // 按 ref 去重，避免同一个文件被上传十次。
      if (seenAssets.has(asset.ref)) return true;
      // 上限按**张数**而不是字节：字节由 zip 的跨趟预算管住，这里要防的是
      // 「一个包里 4000 张小图」——它们不会撑爆内存，但会拖死上传队列。
      if (assets.length >= limits.maxAssets) return false;
      seenAssets.add(asset.ref);
      assets.push(asset);
      return true;
    },

    topic() {
      topics += 1;
      if (topics > limits.maxTopics) {
        // 这里必须**抛**而不是截断：截断会产出一份看似正常、实则少了一半
        // 内容的文档，用户保存后就永久丢了。
        throw new ImportError('TOO_MANY_TOPICS', { max: limits.maxTopics });
      }
    },

    title(value) {
      const cleaned = value.replace(CONTROL_CHARS, '');
      if (cleaned.length <= limits.maxTitleLength) return cleaned;
      truncated += 1;
      let cut = cleaned.slice(0, limits.maxTitleLength);
      // 别把代理对劈成两半：孤立的高位代理会渲染成乱码方块。
      const last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
      return cut;
    },
  };

  return {
    context,
    warnings,
    unsupported,
    assets,
    topicCount: () => topics,
    truncatedTitles: () => truncated,
  };
}
