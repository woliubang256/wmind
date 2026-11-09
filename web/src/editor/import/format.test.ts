/**
 * 文案覆盖测试。
 *
 * 导入层刻意不含任何人类可读文本，全部走 `import.*` 命名空间。代价是
 * 「新增一个 code 但忘了加翻译」不会在类型层面报错——所以在这里逐条核对。
 *
 * 断言的是**资源对象**而不是 `t()` 的返回值：i18next 找不到 key 时会把 key
 * 原样返回，拿 `t()` 的结果做存在性判断永远为真。
 */

import { describe, expect, it } from 'vitest';
import enUS from '../../lib/i18n/locales/en-US.json';
import zhCN from '../../lib/i18n/locales/zh-CN.json';
import { IMPORT_ERROR_CODES } from './errors';
import {
  errorKey,
  featureKey,
  formatKey,
  toMessageParams,
  unsupportedKey,
  warningKey,
  warningMessage,
} from './format';
import { IMPORT_WARNING_CODES, IMPORTED_FEATURES, UNSUPPORTED_FEATURES } from './types';

const LOCALES: Array<[string, Record<string, unknown>]> = [
  ['zh-CN', zhCN as unknown as Record<string, unknown>],
  ['en-US', enUS as unknown as Record<string, unknown>],
];

/**
 * 按 i18next 的规则取值：先按 `.` 深挖，取不到再当作**扁平**键查一次。
 *
 * 本地化文件里两种写法并存（`editor` 下是扁平的 `panel.style.shape`），
 * 只实现深挖会漏判。
 */
function deepLookup(node: unknown, key: string): unknown {
  let current: unknown = node;
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 在 `import` 命名空间里找，允许扁平（`"warning.x"`）或嵌套两种存法。 */
function importEntry(resource: Record<string, unknown>, key: string): unknown {
  const imp = resource.import;
  if (typeof imp !== 'object' || imp === null) return undefined;
  const rest = key.replace(/^import\./, '');
  const bucket = imp as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(bucket, rest)) return bucket[rest];
  return deepLookup(bucket, rest);
}

describe('文案覆盖', () => {
  for (const [locale, resource] of LOCALES) {
    it(`${locale} 覆盖全部错误码`, () => {
      const missing = IMPORT_ERROR_CODES.filter((code) => typeof importEntry(resource, errorKey(code)) !== 'string');
      expect(missing).toEqual([]);
    });

    it(`${locale} 覆盖全部警告码`, () => {
      const missing = IMPORT_WARNING_CODES.filter((code) => typeof importEntry(resource, warningKey(code)) !== 'string');
      expect(missing).toEqual([]);
    });

    it(`${locale} 覆盖全部不支持项`, () => {
      const missing = UNSUPPORTED_FEATURES.filter((f) => typeof importEntry(resource, unsupportedKey(f)) !== 'string');
      expect(missing).toEqual([]);
    });

    it(`${locale} 覆盖全部已还原能力项`, () => {
      const missing = IMPORTED_FEATURES.filter((f) => typeof importEntry(resource, featureKey(f)) !== 'string');
      expect(missing).toEqual([]);
    });

    it(`${locale} 覆盖三种格式名`, () => {
      const missing = (['xmind', 'markdown', 'opml'] as const)
        .filter((f) => typeof importEntry(resource, formatKey(f)) !== 'string');
      expect(missing).toEqual([]);
    });
  }

  it('两种语言的 key 集合一致（不会一边多一边少）', () => {
    const collect = (resource: Record<string, unknown>): string[] => {
      const imp = resource.import;
      if (typeof imp !== 'object' || imp === null) return [];
      return Object.keys(imp as Record<string, unknown>).sort();
    };
    expect(collect(enUS as unknown as Record<string, unknown>))
      .toEqual(collect(zhCN as unknown as Record<string, unknown>));
  });
});

describe('toMessageParams', () => {
  it('把字节参数换成可读大小', () => {
    expect(toMessageParams({ size: 52428800, limit: 52428800 })).toEqual({
      size: '50.0 MB',
      limit: '50.0 MB',
    });
  });

  it('不动非字节参数', () => {
    // count / method 也是数字，但转成 "3.0 B" 就是笑话。
    expect(toMessageParams({ count: 3, method: 14, name: 'content.json' })).toEqual({
      count: 3,
      method: 14,
      name: 'content.json',
    });
  });

  it('没有参数时返回 undefined，而不是空对象', () => {
    // 空对象传给 t() 会让 i18next 走一遍无意义的插值。
    expect(toMessageParams(undefined)).toBeUndefined();
  });
});

describe('warningMessage', () => {
  it('同时给出 key 与已格式化的参数', () => {
    expect(warningMessage({ code: 'image-skipped', params: { count: 2 } })).toEqual({
      key: 'import.warning.image-skipped',
      params: { count: 2 },
    });
  });

  it('无参数警告的 params 是 undefined', () => {
    expect(warningMessage({ code: 'palette-fallback' })).toEqual({
      key: 'import.warning.palette-fallback',
      params: undefined,
    });
  });
});
