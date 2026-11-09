/**
 * 字体覆盖查询：某个码位在这套字体里有没有字形。
 *
 * 数据来自 `font-coverage.json`（由 `scripts/gen-font-coverage.mjs` 从分片清单
 * 派生，区间已排序合并）。**不用 `document.fonts.check()`**：它只回答「字体加载
 * 了没」，对没有字形的码位照样返回 true——拿它判覆盖率会得出「全都覆盖」的假象，
 * 而这正是我们要发现的问题。
 *
 * 这里全部是纯函数：没有 DOM、没有网络，可以在 node 里直接测。导出对话框只是把
 * 结果翻成一句话。
 */

import type { FontFamily } from '../model/types';
import data from './font-coverage.json';

/** 闭区间 `[start, end]`，单位是码位。 */
export type CodeRange = readonly [number, number];

const TABLES = new Map<string, CodeRange[]>(
  Object.entries(data.tables).map(([name, encoded]) => [name, decodeRanges(encoded)]),
);

const FAMILY_TABLE: Readonly<Record<string, string>> = data.families;

function decodeRanges(encoded: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  for (const part of encoded.split(',')) {
    if (part === '') continue;
    const dash = part.indexOf('-');
    if (dash === -1) {
      const value = parseInt(part, 16);
      ranges.push([value, value]);
    } else {
      ranges.push([parseInt(part.slice(0, dash), 16), parseInt(part.slice(dash + 1), 16)]);
    }
  }
  return ranges;
}

/**
 * 该字体族的覆盖区间；`null` 表示「不适用」。
 *
 * 只有随包分发的族才有覆盖表。`system` 返回 `null`——它本来就是系统字体，
 * 拿它去报「用了系统字体」是自相矛盾。
 */
export function coverageOf(family: FontFamily): CodeRange[] | null {
  const table = FAMILY_TABLE[family];
  if (table === undefined) return null;
  return TABLES.get(table) ?? null;
}

/** 二分查找。区间已排序且互不重叠（合并时保证了这两点）。 */
export function isCovered(codePoint: number, ranges: readonly CodeRange[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (codePoint < range[0]) high = mid - 1;
    else if (codePoint > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 文本里没有字形的字符（按码位去重，保持首次出现顺序）。
 *
 * 空白与控制字符不算：它们不画字形，把它们报成「缺字」只会制造噪音。
 * 按码位而不是按 UTF-16 单元遍历——`for...of` 会把代理对合成一个字符，
 * 否则一个 emoji 会被当成两个乱码单元各报一次。
 */
export function uncoveredChars(text: string, ranges: readonly CodeRange[]): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const char of text) {
    if (seen.has(char)) continue;
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    // 空白（含全角空格、不换行空格）与 C0/C1 控制字符：不参与字形匹配。
    if (/\s/.test(char) || codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;

    seen.add(char);
    if (!isCovered(codePoint, ranges)) missing.push(char);
  }

  return missing;
}

/** 覆盖了多少个码位。用于自检与文档，不参与导出。 */
export function coveredCodePointCount(family: FontFamily): number {
  const ranges = coverageOf(family);
  if (ranges === null) return 0;
  return ranges.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
}
