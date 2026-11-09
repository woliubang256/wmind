/**
 * 导入结果 → 界面文案。
 *
 * 从对话框里拆出来是为了**可测**：这里全是纯函数，测试可以拿真实语言包当
 * 翻译器，于是「界面引用了一个不存在的 key」这类错误会在单测里就暴露，而不是
 * 等到用户看到一行 `import.dialog.something`。
 *
 * 所有 `t` 都通过参数注入，而不是在这里 `useTranslation()`——否则这个文件
 * 就没法在 node 环境里跑了。
 */

import { IMPORT_ERROR_CODES } from '@/editor/import/errors';
import { errorKey, featureKey, toMessageParams, unsupportedKey, warningMessage } from '@/editor/import/format';
import type { ImportResult, ImportWarning } from '@/editor/import/types';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface SummaryRow {
  label: string;
  value: string;
}

/**
 * 错误 → 文案。
 *
 * 只对**认识的错误码**查语言包：`ImportError.code` 是字符串，将来某个适配器
 * 抛了没登记过的码时，直接 `t('import.error.WHATEVER')` 会把 key 原样显示出来。
 */
export function importErrorMessage(error: unknown, t: Translate): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && (IMPORT_ERROR_CODES as readonly string[]).includes(code)) {
      const params = (error as { params?: Record<string, string | number> }).params;
      return t(errorKey(code), toMessageParams(params));
    }
  }
  return t('import.dialog.unknownError');
}

export function importWarningText(warning: ImportWarning, t: Translate): string {
  const { key, params } = warningMessage(warning);
  return t(key, params);
}

/** 「画布 1 个 / 主题 42 个（最大层级 4）」两行。 */
export function summaryRows(result: ImportResult, t: Translate): SummaryRow[] {
  return [
    { label: t('import.dialog.sheets'), value: t('import.dialog.sheetsValue', { n: result.summary.sheets }) },
    {
      label: t('import.dialog.topics'),
      value: t('import.dialog.topicsValue', { n: result.summary.topics, depth: result.summary.maxDepth }),
    },
  ];
}

/**
 * 「未能还原」列表。
 *
 * 按数量倒序：用户最关心「丢了 3 个贴纸」而不是「丢了 1 个自定义标记」。
 * 数量相同则按名字排，保证同一份文件两次导入的顺序一致。
 */
export function unsupportedRows(result: ImportResult, t: Translate): SummaryRow[] {
  return Object.entries(result.unsupported)
    .sort(([leftName, leftCount], [rightName, rightCount]) => {
      if (rightCount !== leftCount) return rightCount - leftCount;
      return leftName.localeCompare(rightName);
    })
    .map(([feature, count]) => ({
      label: t(unsupportedKey(feature as Parameters<typeof unsupportedKey>[0])),
      value: `× ${count}`,
    }));
}

/** 「已还原」的标签。顺序由 `summarizeImport()` 固定，界面不再排。 */
export function restoredLabels(result: ImportResult, t: Translate): string[] {
  return result.summary.restored.map((feature) => t(featureKey(feature)));
}
