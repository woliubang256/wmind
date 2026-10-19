/**
 * 导入结果 → 文案的测试。
 *
 * 翻译器是**真实语言包**解析出来的：这样「界面引用了不存在的 key」会在单测里
 * 就暴露（表现为返回 `MISSING:xxx`），而不是等用户看到一行 `import.dialog.xxx`。
 *
 * 顺便覆盖「不认识错误码时不要拼出一个假 key」这条——`ImportError.code` 是
 * 字符串，任何适配器都能抛出一个没登记过的值。
 */

import { describe, expect, it } from 'vitest';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import { ImportError } from '@/editor/import/errors';
import type { ImportResult, ImportWarning } from '@/editor/import/types';
import {
  importErrorMessage,
  importWarningText,
  restoredLabels,
  summaryRows,
  unsupportedRows,
  type Translate,
} from './import-present';

function resolver(resources: Record<string, unknown>): Translate {
  const flat = new Map<string, string>();
  const walk = (node: unknown, prefix: string) => {
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, prefix === '' ? key : `${prefix}.${key}`);
      }
      return;
    }
    flat.set(prefix, String(node));
  };
  walk(resources, '');

  return (key, params) => {
    const template = flat.get(key);
    if (template === undefined) return `MISSING:${key}`;
    if (!params) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    );
  };
}

const zh = resolver(zhCN as Record<string, unknown>);
const en = resolver(enUS as Record<string, unknown>);

function resultOf(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    format: 'markdown',
    document: { title: '导入的图' } as ImportResult['document'],
    warnings: [],
    unsupported: {},
    summary: { sheets: 1, topics: 42, maxDepth: 4, restored: ['structure', 'notes', 'labels'] },
    ...overrides,
  };
}

describe('importErrorMessage', () => {
  it('认识的错误码翻成文案，字节参数变成人类可读', () => {
    const error = new ImportError('FILE_TOO_LARGE', { size: 104_857_600, limit: 52_428_800 });
    expect(importErrorMessage(error, zh)).toBe('文件太大（100 MB），上限是 50.0 MB。');
  });

  it('两个语言包都能翻', () => {
    const error = new ImportError('EMPTY_DOCUMENT');
    expect(importErrorMessage(error, en)).toBe('No canvas was found. The file may be empty or corrupted.');
  });

  it('不认识的错误码走通用文案，不拼假 key', () => {
    // 直接 `t('import.error.WHATEVER')` 会把 key 原样显示给用户。
    const error = Object.assign(new Error('boom'), { code: 'WHATEVER' });
    expect(importErrorMessage(error, zh)).toBe('导入失败，请换一个文件试试。');
  });

  it('普通异常走通用文案', () => {
    expect(importErrorMessage(new TypeError('x is undefined'), zh)).toBe('导入失败，请换一个文件试试。');
    expect(importErrorMessage('字符串也行', zh)).toBe('导入失败，请换一个文件试试。');
    expect(importErrorMessage(null, zh)).toBe('导入失败，请换一个文件试试。');
  });

  it('「个」类的上限参数不会被当成字节数', () => {
    // 曾经这里用的是 `limit`，于是文案变成「节点数超过上限（19.5 KB 个）」。
    // 现在「个」类上限一律叫 `max`，只有 `size` / `limit` 走字节格式化。
    const error = new ImportError('TOO_MANY_TOPICS', { max: 20_000 });
    expect(importErrorMessage(error, zh)).toBe('节点数超过上限（20000 个），请先在原工具里把导图拆小。');
  });
});

describe('importWarningText', () => {
  it('每条警告都能翻成文案', () => {
    const warning: ImportWarning = { code: 'image-skipped', params: { count: 3 } };
    expect(importWarningText(warning, zh)).toBe('有 3 张图片没能导入。');
  });

  it('字体归一警告带原名与目标族', () => {
    const warning: ImportWarning = { code: 'font-normalized', params: { from: '楷体', to: 'serif' } };
    expect(importWarningText(warning, zh)).toBe('字体「楷体」不受支持，已归一为 serif 字体族。');
  });
});

describe('summaryRows', () => {
  it('两行：画布数与主题数', () => {
    expect(summaryRows(resultOf(), zh)).toEqual([
      { label: '画布', value: '1 个' },
      { label: '主题', value: '42 个（最大层级 4）' },
    ]);
  });

  it('英文语言包也完整', () => {
    const rows = summaryRows(resultOf({ summary: { sheets: 2, topics: 7, maxDepth: 3, restored: [] } }), en);
    expect(rows).toEqual([
      { label: 'Canvases', value: '2' },
      { label: 'Topics', value: '7 (max depth 3)' },
    ]);
  });
});

describe('unsupportedRows', () => {
  it('按数量倒序，数量相同按名字排', () => {
    const rows = unsupportedRows(resultOf({ unsupported: { 'custom-marker': 1, sticker: 3, gantt: 1 } }), zh);
    // 数量相同时按**特性 id** 排（`custom-marker` < `gantt`），不是按译名：
    // 译名排序会随语言变化，同一份文件在中英文界面里的顺序就不一样了。
    expect(rows).toEqual([
      { label: '贴纸', value: '× 3' },
      { label: '自定义标记', value: '× 1' },
      { label: '甘特图数据', value: '× 1' },
    ]);
  });

  it('没有未能还原项时是空数组', () => {
    expect(unsupportedRows(resultOf(), zh)).toEqual([]);
  });
});

describe('restoredLabels', () => {
  it('顺序跟 summary.restored 走', () => {
    expect(restoredLabels(resultOf(), zh)).toEqual(['结构', '备注', '标签']);
  });

  it('英文语言包也完整', () => {
    expect(restoredLabels(resultOf({ summary: { sheets: 1, topics: 1, maxDepth: 1, restored: ['structure'] } }), en)).toEqual([
      'Structure',
    ]);
  });
});

describe('文案键的完整性', () => {
  it('这里用到的每个 key 在两个语言包里都存在', () => {
    const texts = [
      importErrorMessage(new ImportError('FILE_TOO_LARGE', { size: 1, limit: 2 }), zh),
      importErrorMessage(new ImportError('UNKNOWN_FORMAT', { fileName: 'a.bin' }), zh),
      importErrorMessage(new ImportError('UNZIP_LIMIT_EXCEEDED', { limit: 1, name: 'x' }), zh),
      importErrorMessage(new ImportError('ENTRY_TOO_LARGE', { name: 'x', size: 1, limit: 2 }), zh),
      importErrorMessage(new ImportError('TOO_MANY_ENTRIES', { max: 1 }), zh),
      importErrorMessage(new ImportError('PARSE_FAILED', { fileName: 'x' }), zh),
      importErrorMessage(new ImportError('NOT_A_ZIP'), zh),
      importErrorMessage(new ImportError('ENCRYPTED'), zh),
      importErrorMessage(new ImportError('TOO_MANY_TOPICS', { max: 1 }), zh),
      importErrorMessage(new ImportError('EMPTY_DOCUMENT'), zh),
      importErrorMessage(new Error('x'), zh),
      importWarningText({ code: 'palette-fallback' }, zh),
      importWarningText({ code: 'gradient-flattened' }, zh),
      importWarningText({ code: 'structure-fallback', params: { from: 'x' } }, zh),
      importWarningText({ code: 'table-degraded' }, zh),
      importWarningText({ code: 'attachment-noted', params: { count: 1 } }, zh),
      importWarningText({ code: 'styles-ignored' }, zh),
      importWarningText({ code: 'marker-unknown', params: { count: 1 } }, zh),
      importWarningText({ code: 'title-truncated', params: { count: 1 } }, zh),
      importWarningText({ code: 'document-normalized', params: { count: 1 } }, zh),
      ...summaryRows(resultOf(), zh).flatMap((row) => [row.label, row.value]),
      ...restoredLabels(resultOf(), zh),
      ...unsupportedRows(resultOf({ unsupported: { sticker: 1, attachment: 1, audio: 1, recording: 1, 'custom-marker': 1, gantt: 1, wallpaper: 1 } }), zh).map((row) => row.label),
    ];

    for (const text of texts) {
      expect(text).not.toContain('MISSING:');
      // 未替换的占位符说明语言包里少了对应的参数。
      expect(text).not.toMatch(/\{\{\w+\}\}/);
    }
  });
});
