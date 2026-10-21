/**
 * 语言包的守卫测试。
 *
 * 这一层原先完全没有测试，而它恰好是最容易悄悄坏掉的地方：
 *
 * - 加一条中文忘了加英文 → 英文用户看到 `admin.users.title` 这种键名。
 *   `returnNull: false` 让 `t()` 找不到键时**把键原样返回**，不报错、不告警。
 * - 英文里漏了 `{{count}}` → 界面上写着 "users" 却不带数字。
 * - 代码里 `t('xxx.yyy')` 打错一个字母 → 同上，静默显示键名。
 *
 * 三条断言分别盯住这三件事。第三条是静态扫描（正则捞 `t('...')` 字面量），
 * 只覆盖字面量键；`t(field.labelKey)` 这种动态键由各自的映射表负责，
 * 这里捞不到也不该捞。
 */

import { describe, expect, it } from 'vitest';
import enUS from './locales/en-US.json';
import zhCN from './locales/zh-CN.json';

type Bundle = Record<string, unknown>;

const zh = zhCN as unknown as Bundle;
const en = enUS as unknown as Bundle;

/**
 * 递归摊平成 `点号路径 → 值`。
 *
 * 语言包是**混合**结构：顶层是命名空间对象，命名空间内部却是带点的扁平键
 * （`"panel.style.shape": "..."`），所以不能只摊一层——`share.badge` 就是
 * 再嵌一层的对象。两种写法摊出来的路径字符串长得一样，所以同名即冲突，
 * 直接报错：那是 i18next 自己也会含糊的地方，不该留到线上。
 */
function flatten(bundle: Bundle): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const full = prefix === '' ? key : `${prefix}.${key}`;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, full);
        continue;
      }
      if (out.has(full)) throw new Error(`语言包路径冲突：${full}`);
      out.set(full, value);
    }
  };
  walk(bundle, '');
  return out;
}

const ZH = flatten(zh);
const EN = flatten(en);

/** 按点号路径取值。 */
function lookup(bundle: Map<string, unknown>, key: string): unknown {
  return bundle.get(key);
}

/** 取字符串里的 `{{name}}` 占位符集合。 */
function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!).sort();
}

/**
 * 源码正文，键是相对路径。
 *
 * 用 Vite 的 `import.meta.glob` 而不是 `node:fs`：这个项目没有装 `@types/node`，
 * tsconfig 的 `types` 也只放行 `vite/client` 与 `vitest/globals`，一旦 `import
 * 'node:fs'` 类型检查就会红。`?raw` 由 Vite 在转换期直接内联成字符串，测试与
 * 生产构建走同一条解析路径，也不依赖当前工作目录。
 */
const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * 去掉注释，保留字符串与 JSX 文本。
 *
 * 不剥的话，注释里举的**反例**会被当成真的调用——`import-present.ts` 的注释里
 * 写着「直接 `t('import.error.WHATEVER')` 会把 key 原样显示」，扫描器就把它
 * 当成一个缺失的键报出来。这不是刁难：注释里的例子本来就该写真实形态。
 *
 * 手写状态机而不是正则：`//` 会出现在字符串（`'https://…'`）和正则字面量里，
 * 用正则剥注释会把 `url.replace(/\//g, ...)` 后面的整行吃掉。
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (mode === 'code') {
      if (char === '/' && next === '/') {
        mode = 'line';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        mode = 'block';
        index += 2;
        continue;
      }
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '`') mode = 'template';
      out += char;
      index += 1;
      continue;
    }
    if (mode === 'line') {
      if (char === '\n') {
        mode = 'code';
        out += char;
      }
      index += 1;
      continue;
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') {
        mode = 'code';
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    // 字符串里：处理转义，遇到同种引号结束。
    if (char === '\\') {
      out += char + (next ?? '');
      index += 2;
      continue;
    }
    if (
      (mode === 'single' && char === "'") ||
      (mode === 'double' && char === '"') ||
      (mode === 'template' && char === '`')
    ) {
      mode = 'code';
    }
    out += char;
    index += 1;
  }
  return out;
}

/** 参与扫描的源文件：跳过测试文件与语言包自身。 */
function sourceFiles(): [string, string][] {
  return Object.entries(SOURCES)
    .filter(([file]) => !/\.test\.tsx?$/.test(file) && !file.includes('/lib/i18n/'))
    .map(([file, source]) => [file, stripComments(source)]);
}

/**
 * 从源码里捞出所有 `t('a.b')` / `i18n.t('a.b')` 的字面量键。
 *
 * 只认「有命名空间（至少一个点）、不含空格与 `${`」的字符串：`t('确定')`
 * 这类不带命名空间的调用不是本项目的约定（会漏翻），单独由下面的断言覆盖。
 */
function literalKeys(source: string): string[] {
  const found: string[] = [];
  const pattern = /\bt\(\s*'([^'\\\s]+)'/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1]!;
    if (!key.includes('.')) continue;
    if (key.includes('${')) continue;
    found.push(key);
  }
  return found;
}

describe('语言包', () => {
  it('两种语言的键完全一致', () => {
    const zhKeys = [...ZH.keys()];
    const enKeys = [...EN.keys()];
    const missingInEn = zhKeys.filter((key) => !EN.has(key));
    const missingInZh = enKeys.filter((key) => !ZH.has(key));
    expect({ missingInEn, missingInZh }).toEqual({ missingInEn: [], missingInZh: [] });
  });

  it('没有空字符串，也没有把键名当值', () => {
    for (const [locale, bundle] of [['zh-CN', ZH], ['en-US', EN]] as const) {
      for (const flatKey of bundle.keys()) {
        const value = lookup(bundle, flatKey);
        expect(typeof value, `${locale} ${flatKey}`).toBe('string');
        expect((value as string).trim(), `${locale} ${flatKey}`).not.toBe('');
        // 复制粘贴时最容易犯的错：值写成键本身。
        expect(value, `${locale} ${flatKey}`).not.toBe(flatKey);
      }
    }
  });

  it('同一条文案在两种语言里的占位符一致', () => {
    const diverged: string[] = [];
    for (const flatKey of ZH.keys()) {
      const zhVars = placeholders(lookup(ZH, flatKey));
      const enVars = placeholders(lookup(EN, flatKey));
      if (zhVars.join(',') !== enVars.join(',')) diverged.push(flatKey);
    }
    expect(diverged).toEqual([]);
  });

  it('源码里出现的字面量键都在语言包里', () => {
    const missing = new Map<string, string[]>();
    for (const [file, source] of sourceFiles()) {
      // 只扫真正用了 i18n 的文件：别的文件里 `t('a.b')` 可能是局部变量。
      if (!source.includes('useTranslation') && !source.includes('i18n.t')) continue;
      for (const key of literalKeys(source)) {
        if (ZH.has(key)) continue;
        missing.set(key, [...(missing.get(key) ?? []), file]);
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  it('不允许不带命名空间的 t() 调用', () => {
    // `t('确定')` 会去顶层找名为「确定」的键，找不到就把「确定」原样显示——
    // 中文下看起来是对的，切到英文还是中文。这类调用只能靠约定禁止。
    const offenders: string[] = [];
    for (const [file, source] of sourceFiles()) {
      if (!source.includes('useTranslation') && !source.includes('i18n.t')) continue;
      for (const match of source.matchAll(/\bt\(\s*'([^'\\\s]+)'/g)) {
        if (!match[1]!.includes('.')) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
