#!/usr/bin/env node
/**
 * 从字体分片清单派生「码位覆盖表」（离线，只读 manifest.json）。
 *
 * 为什么需要这张表：docs/06 §4.2 要求导出时能回答「这次导出有没有用到回退字体」，
 * 而不是静默出图。浏览器给不出这个答案——`document.fonts.check()` 只看「字体
 * 加载了没」，不看「有没有这个字的字形」；拿它判覆盖率会得出「全都覆盖」的假象。
 * 唯一可靠的信息源是分片自己的 `unicode-range`。
 *
 * 为什么不直接读 `public/fonts/manifest.json`（841 KB）：导出对话框只需要「哪些
 * 码位被覆盖」，不需要分片文件名与字节数。这里把 505 条 face 记录压成**合并后的
 * 码位区间**，并按内容去重——思源黑体与思源宋体用的是同一套 Google CJK 切分，
 * 两者覆盖完全相同，存一份就够。产物 ~36 KB，进导出对话框的懒加载分块，不发请求。
 *
 * 用法：
 *   node scripts/gen-font-coverage.mjs          写入
 *   node scripts/gen-font-coverage.mjs --check   只校验，不一致时退出码 1（CI 用）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'frontend/public/fonts/manifest.json');
const OUTPUT_PATH = join(ROOT, 'frontend/src/editor/theme/font-coverage.json');

/**
 * 解析一条 CSS `unicode-range` 值。
 *
 * 支持三种写法：`U+3002`（单码位）、`U+4E00-9FFF`（区间）、`U+4E??`（通配，
 * 问号位展开成 0~F）。Google 的 CJK 分片三种都会出现，少一种就会静默丢覆盖。
 */
export function parseUnicodeRange(value) {
  const ranges = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const match = /^U\+([0-9A-Fa-f?]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/.exec(token);
    if (match === null) continue;

    const head = match[1];
    const tail = match[2];
    if (head.includes('?')) {
      ranges.push([parseInt(head.replaceAll('?', '0'), 16), parseInt(head.replaceAll('?', 'F'), 16)]);
    } else {
      const start = parseInt(head, 16);
      ranges.push([start, tail === undefined ? start : parseInt(tail, 16)]);
    }
  }
  return ranges;
}

/** 排序并合并相邻/重叠区间。合并后二分查找才成立，体积也小一个量级。 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** 区间 → `hex-hex,hex,...`。用 16 进制是因为码位本身就是 16 进制概念。 */
export function encodeRanges(ranges) {
  return ranges
    .map(([start, end]) => (start === end ? start.toString(16) : `${start.toString(16)}-${end.toString(16)}`))
    .join(',');
}

/** 读 manifest，产出 { tables, families }。表按内容去重，族名指向表名。 */
export function buildCoverage(manifest) {
  const tables = {};
  const byEncoded = new Map();
  const families = {};

  for (const family of manifest.families) {
    const ranges = [];
    for (const face of family.faces) ranges.push(...parseUnicodeRange(face.unicodeRange));

    const encoded = encodeRanges(mergeRanges(ranges));
    let name = byEncoded.get(encoded);
    if (name === undefined) {
      // 表名优先用覆盖类别（`cjk` / `latin`），同类别出现第二份内容时加后缀。
      const base = family.coverage ?? family.key;
      name = tables[base] === undefined ? base : `${base}-${Object.keys(tables).length}`;
      tables[name] = encoded;
      byEncoded.set(encoded, name);
    }
    families[family.key] = name;
  }

  return { tables, families };
}

/** 产出最终文件内容。导出给 `check-fonts.mjs` 用，两处必须是同一个函数。 */
export function renderCoverage(manifest) {
  const { tables, families } = buildCoverage(manifest);
  const payload = {
    generatedBy: 'scripts/gen-font-coverage.mjs',
    note: '由 public/fonts/manifest.json 派生，勿手改。区间为 16 进制、已排序合并。',
    tables,
    families,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gen-font-coverage.mjs')) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const next = renderCoverage(manifest);

  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT_PATH, 'utf8');
    } catch {
      current = '';
    }
    if (current !== next) {
      console.error('font-coverage.json 与 manifest.json 不一致，请重跑 node scripts/gen-font-coverage.mjs');
      process.exit(1);
    }
    console.log('ok: font-coverage.json 与 manifest.json 一致');
  } else {
    writeFileSync(OUTPUT_PATH, next);
    const size = Buffer.byteLength(next);
    console.log(`wrote ${OUTPUT_PATH} (${(size / 1024).toFixed(1)} KB)`);
  }
}
